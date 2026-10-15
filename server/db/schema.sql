-- Nexus CRM schema (enquiry -> enrolment)
-- Safe to re-run: drops and recreates everything.

DROP TABLE IF EXISTS local_file, email_log, task, audit_log, stage_history, enrolment, document,
  program_document_type, application,
  qualification, signup_token, enquiry, prospect, student_user, intake,
  program, staff_user CASCADE;

CREATE TABLE staff_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('recruiter', 'manager')),
  password_hash TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE program (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  discipline              TEXT NOT NULL,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  brochure_url            TEXT,
  -- 1 Year 12, 2 Certificate, 3 Diploma, 4 Bachelor, 5 Master (see src/criteria.js)
  min_qualification_level INT,
  -- e.g. {"IELTS": 6.0, "PTE": 50, "TOEFL": 60}; NULL = no criteria configured
  language_requirements   JSONB
);

CREATE TABLE intake (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES program(id),
  name       TEXT NOT NULL,
  start_date DATE NOT NULL,
  is_open    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE student_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE prospect (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assigned_staff_id     UUID REFERENCES staff_user(id),
  user_id               UUID UNIQUE REFERENCES student_user(id),
  full_name             TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  address               TEXT,
  stage                 TEXT NOT NULL DEFAULT 'Enquiry' CHECK (stage IN
    ('Enquiry', 'Qualification review', 'Qualified', 'Application', 'Offer', 'Enrolled', 'Closed')),
  closed_reason         TEXT CHECK (closed_reason IN
    ('No response', 'Not eligible', 'Application rejected', 'Offer declined', 'Offer lapsed', 'Withdrawn')),
  possible_duplicate_of UUID REFERENCES prospect(id),
  consent_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a Closed prospect must carry a reason, and only a Closed one may
  CHECK ((stage = 'Closed') = (closed_reason IS NOT NULL))
);
CREATE UNIQUE INDEX prospect_email_unique ON prospect (lower(email));
CREATE INDEX prospect_stage_idx ON prospect (stage);
CREATE INDEX prospect_phone_idx ON prospect (phone);

CREATE TABLE enquiry (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id  UUID NOT NULL REFERENCES prospect(id),
  program_id   UUID NOT NULL REFERENCES program(id),
  source       TEXT NOT NULL DEFAULT 'Website',
  message      TEXT,
  enquiry_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE signup_token (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospect(id),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE qualification (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id           UUID NOT NULL UNIQUE REFERENCES prospect(id),
  program_id            UUID NOT NULL REFERENCES program(id),
  highest_qualification TEXT,
  institution           TEXT,
  year_completed        INT,
  result                TEXT,
  language_test_type    TEXT,
  language_score        NUMERIC(5,1),
  test_date             DATE,
  intake_id             UUID REFERENCES intake(id),
  submitted_at          TIMESTAMPTZ,
  auto_result           TEXT CHECK (auto_result IN ('Pass', 'Fail', 'Review')),
  auto_reasons          JSONB,
  decision              TEXT CHECK (decision IN ('Approved', 'Rejected')),
  reviewed_by           UUID REFERENCES staff_user(id),
  review_note           TEXT,
  decided_at            TIMESTAMPTZ
);

CREATE TABLE application (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id    UUID NOT NULL REFERENCES prospect(id),
  program_id     UUID NOT NULL REFERENCES program(id),
  intake_id      UUID REFERENCES intake(id),
  status         TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN
    ('Draft', 'Submitted', 'Under review', 'Accepted', 'Rejected', 'Withdrawn')),
  submitted_date TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- enrolment details, filled in by the student (step 5)
  date_of_birth           DATE,
  nationality             TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  study_mode              TEXT CHECK (study_mode IN ('On campus', 'Online', 'Blended')),
  -- staff decision and offer (step 6)
  decision_by      UUID REFERENCES staff_user(id),
  decision_note    TEXT,
  decided_at       TIMESTAMPTZ,
  offer_expires_at TIMESTAMPTZ
);
CREATE INDEX application_prospect_idx ON application (prospect_id, created_at);

-- The document checklist for each program.
CREATE TABLE program_document_type (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    UUID NOT NULL REFERENCES program(id),
  document_type TEXT NOT NULL,
  is_required   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (program_id, document_type)
);

-- Uploaded files and issued letters. The file itself is in storage (Supabase
-- Storage, or local_file when running locally); storage_path points to it.
CREATE TABLE document (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES application(id),
  document_type    TEXT NOT NULL,
  issued           BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE = created by RIC (offer letter)
  file_name        TEXT NOT NULL,
  mime_type        TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes       INT NOT NULL,
  storage_path     TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Verified', 'Rejected')),
  rejection_reason TEXT,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      UUID REFERENCES staff_user(id),
  verified_at      TIMESTAMPTZ,
  CHECK ((status = 'Rejected') = (rejection_reason IS NOT NULL))
);
-- One current upload per document type per application.
CREATE UNIQUE INDEX document_one_per_type ON document (application_id, document_type) WHERE NOT issued;

CREATE TABLE enrolment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL UNIQUE REFERENCES application(id),
  enrolment_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per stage change. Source for all pipeline reports.
CREATE TABLE stage_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id     UUID NOT NULL REFERENCES prospect(id),
  from_stage      TEXT,
  to_stage        TEXT NOT NULL,
  closed_reason   TEXT,
  changed_by_type TEXT NOT NULL CHECK (changed_by_type IN ('student', 'staff', 'system')),
  changed_by_id   UUID,
  -- clock_timestamp(), not now(): two changes in one transaction keep their order
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX stage_history_prospect_idx ON stage_history (prospect_id, changed_at);

CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospect(id),
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('student', 'staff', 'system')),
  actor_id    UUID,
  action      TEXT NOT NULL,
  detail      JSONB,
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE task (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       UUID NOT NULL REFERENCES prospect(id),
  assigned_staff_id UUID REFERENCES staff_user(id),
  type              TEXT NOT NULL,
  due_at            TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Done')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  escalated_at      TIMESTAMPTZ
);

CREATE TABLE email_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID REFERENCES prospect(id),
  template    TEXT NOT NULL,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('Sent', 'Logged', 'Failed')),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stand-in for Supabase Storage when running locally without Supabase.
CREATE TABLE local_file (
  path       TEXT PRIMARY KEY,
  mime_type  TEXT NOT NULL,
  content    BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
