# Nexus CRM

Student recruitment CRM for RIC, covering the whole journey from enquiry to enrolment:

1. **Enquiry** – public form with validation, duplicate check, automatic staff assignment, and account creation
2. **Brochure email** – sent automatically after the enquiry
3. **Academic and language details** – student portal form with save-as-draft
4. **Eligibility check** – automatic check against the program's criteria; unclear or failed cases go to staff
5. **Application** – enrolment details and document upload; staff verify or reject each document
6. **Offer** – staff accept the application and an offer letter PDF is generated
7. **Enrolment** – the student accepts the offer in the portal

Around that flow:

- **Reminders and automatic closing** – reminders for stalled records, lapsed offers, "no response" closures, and overdue staff tasks escalated to the manager
- **Pipeline report** – how many prospects reach each stage, where they are lost and why
- **History** – every stage change is written to `stage_history` and `audit_log`

## Stack

- `client/` – React (Vite), React Router. On Vercel: static site.
- `server/` – Node.js, Express, PostgreSQL (`pg`), JWT logins. On Vercel: one serverless function (`api/index.js`).
- **Supabase** – the PostgreSQL database, and Storage for uploaded documents and offer letters.

This is the Vercel and Supabase version of the original `nexus-crm` project. The screens and business rules are the same; what changed:

| Area | Original | This version |
| --- | --- | --- |
| Hosting | Run on your own machine | Vercel (front end and API in one project) |
| Database | Local PostgreSQL | Supabase PostgreSQL (local PostgreSQL still works) |
| Uploaded files | Inside the database, sent through the API | Supabase Storage. The browser uploads straight to storage, because Vercel limits a request to about 4.5 MB |
| Reminder checks | Timer inside the API, every 6 hours | Vercel Cron calls `/api/cron/daily-jobs` once a day |

Without Supabase settings, files are kept in a `local_file` database table instead, so the project still runs and tests on a laptop with plain PostgreSQL.

## Deploy to Vercel and Supabase

**1. Supabase**

1. Create a project at supabase.com. Note the database password you choose.
2. **Project Settings → API**: copy the **Project URL** and the **service_role** key. The service role key is secret: put it only in Vercel and your `server/.env`, never in the front end or GitHub.
3. **Project Settings → Database → Connection string**: copy two strings:
   - **Transaction pooler** (port 6543), for Vercel
   - **Session pooler** (port 5432), for running `db:reset` from your computer

**2. Create the tables (from your computer, once)**

In `server/.env` set `DATABASE_URL` to the session pooler string (with your password in it), `DATABASE_SSL=true`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Then:

```bash
npm install
npm run db:reset      # creates the tables, demo data and the private "documents" bucket
```

**3. Vercel**

1. At vercel.com, **Add New → Project** and import this GitHub repository. Leave the root directory as the repository root; `vercel.json` sets the build.
2. Before deploying, add these **Environment Variables**:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | the **transaction pooler** string |
| `DATABASE_SSL` | `true` |
| `PG_POOL_MAX` | `2` |
| `SUPABASE_URL` | the Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service role key |
| `JWT_SECRET` | a long random string |
| `CRON_SECRET` | another long random string |
| `APP_URL` | your Vercel address, for example `https://nexus-crm-vercel.vercel.app` |

3. Deploy. Open the address and send an enquiry to check it works.
4. If the address differs from `APP_URL`, update `APP_URL` and redeploy, so links in emails are right.

Every push to `main` deploys again automatically.

**Checks after deploying:** `https://<your-address>/api/health` shows `{"ok":true}`; an uploaded document appears in Supabase under **Storage → documents**; the cron job is listed under the project's **Settings → Cron Jobs**.

## Run it locally

You need Node.js 20+ and either a Supabase project (above) or local PostgreSQL 14+.

```bash
# Local PostgreSQL only (once):
psql -U postgres -c "CREATE USER nexus WITH PASSWORD 'nexus' CREATEDB;"
psql -U postgres -c "CREATE DATABASE nexus_crm OWNER nexus;"

# From the repository root:
cp server/.env.example server/.env   # then edit it
npm install                          # installs both server and client
npm run db:reset                     # creates tables and demo data (wipes existing data)
npm run dev:server                   # API on http://localhost:4000
npm run dev:client                   # second terminal: app on http://localhost:5173
```

Locally the reminder checks still run every 6 hours inside the API.

## Demo logins

| Role | Email | Password |
| --- | --- | --- |
| Recruiter | sarah@ric.test | Password123! |
| Recruiter | michael@ric.test | Password123! |
| Manager (read-only) | manager@ric.test | Password123! |

These are demo accounts created by `npm run db:reset`. Change them before any real use.

## Trying the flow

1. Open http://localhost:5173, fill in the enquiry form and choose a password. This creates the student account and opens the portal.
2. Submit the academic and language form. A strong one moves to **Qualified** automatically. A borderline or failing one creates a task for the assigned recruiter, who approves or rejects it from the prospect page.
3. As the student, fill in the application and upload the three documents (any PDF, JPG or PNG), then submit.
4. Log in as a recruiter at `/staff`, open the prospect, verify each document, then choose **Accept and issue offer**.
5. Back in the student portal, download the offer letter and choose **Accept offer**.
6. Log in as the manager to see **Reports** and to run the reminder checks on demand.

A task appears only on the dashboard of the recruiter the prospect is assigned to, but any recruiter can open any prospect.

Emails (brochure, qualified, not eligible) are recorded on the staff **Email log** page and not sent until you set `SMTP_HOST` in `server/.env`.

Because the account is created without an emailed link, the email address is not verified. Add an email confirmation step once a mail server is set up.

## Tests

```bash
npm test        # from the root: resets the database, then runs the 29 API tests
```

Run the tests against a local or test database, never the live one: they wipe it.

## Where things are

| File | What it does |
| --- | --- |
| `server/db/schema.sql` | All tables and constraints |
| `server/src/pipeline.js` | Allowed stage transitions; the only place a stage changes |
| `server/src/criteria.js` | Eligibility rules (qualification levels, test score ranges and margins) |
| `server/src/validate.js` | Field validation rules |
| `server/src/mailer.js` | Email templates and sending |
| `server/src/application.js` | Document checklist, file checks, download |
| `server/src/offerLetter.js` | Offer letter PDF |
| `server/src/storage.js` | File storage: Supabase Storage, or the local table |
| `server/src/routes/system.js` | Local file upload and download links, and the cron endpoint |
| `api/index.js`, `vercel.json` | Vercel entry point, routing, cron schedule |
| `server/src/jobs.js` | Reminder, auto-close and escalation rules, with their day limits in `RULES` |
| `server/src/routes/` | `public.js` (enquiry, sign-up, login), `student.js`, `studentApplication.js`, `staff.js`, `staffApplication.js` (includes reports) |
| `client/src/pages/` | One file per screen |

## Good to know

- Files are in a private bucket. Downloads go through the API, which checks who is asking and returns a link that works for 60 seconds.
- After a file is uploaded, the API reads it back and checks that it really is a PDF, JPG or PNG under 10 MB; anything else is deleted.
- Vercel's free plan runs cron jobs about once a day, so reminders go out daily (20:00 UTC, which is early morning in Sydney). Managers can also run them from the Reports page.
- Timings: details reminder after 3 days and close after 14; application reminder after 7 days and close after 30; rejected-document reminder after 5 days and close after 21; offers last 14 days with a reminder 7 days before; tasks escalate 2 working days after their due date.
- The database connection uses SSL without checking the certificate against a CA. For production, download Supabase's CA certificate and pass it in `server/src/db.js`.

## Not built yet

- Email verification, login rate limiting and password reset
- Staff screens to manage programs, intakes, entry criteria, document checklists and staff accounts (these come from `server/db/reset.js`)
- CSV export of reports
