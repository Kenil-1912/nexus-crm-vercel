// Student portal, steps 5 to 7: application form, document upload, offer, enrolment, withdrawal.
// Every query is scoped to the logged-in student's own prospect record.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError, audit, changeStage, closeProspect, createTask, ensureTask } from '../pipeline.js';
import { isUuid, validateApplication } from '../validate.js';
import {
  FILE_TYPES, MAX_FILE_BYTES, STUDY_MODES, cleanFileName, contentMatchesType, currentApplication,
  documentChecklist, isApplicationPath, missingDocuments, newStoragePath,
} from '../application.js';
import { createDownloadUrl, createUploadTarget, readFile, removeFiles } from '../storage.js';
import { sendEmail, templates } from '../mailer.js';

const router = Router();
router.use(requireAuth('student'));
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

const DETAIL_FIELDS = ['date_of_birth', 'nationality', 'emergency_contact_name', 'emergency_contact_phone', 'study_mode', 'intake_id'];
const invalid = (errors) => new HttpError(422, 'Please correct the highlighted fields.', { errors });

async function loadProspect(client, userId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT id, full_name, email, address, stage, assigned_staff_id FROM prospect WHERE user_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  if (!rows.length) throw new HttpError(404, 'No enquiry is linked to this account.');
  return rows[0];
}

const programName = async (client, programId) =>
  (await client.query('SELECT name FROM program WHERE id = $1', [programId])).rows[0].name;

async function saveDetails(client, applicationId, value) {
  await client.query(
    `UPDATE application SET ${DETAIL_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [applicationId, ...DETAIL_FIELDS.map((f) => value[f])],
  );
}

async function checkIntake(client, intakeId, programId) {
  const { rows } = await client.query('SELECT 1 FROM intake WHERE id = $1 AND program_id = $2 AND is_open', [intakeId, programId]);
  if (!rows.length) throw invalid({ intake_id: 'Select an open intake for this program.' });
}

router.get('/application', wrap(async (req, res) => {
  const prospect = await loadProspect({ query }, req.user.sub);
  const application = await currentApplication({ query }, prospect.id);
  if (!application || !['Qualified', 'Application', 'Offer', 'Enrolled'].includes(prospect.stage)) {
    return res.json({ application: null });
  }
  const [checklist, intakes, letter, enrolment, intake] = await Promise.all([
    documentChecklist({ query }, application),
    query('SELECT id, name, start_date FROM intake WHERE program_id = $1 AND (is_open OR id = $2) ORDER BY start_date', [application.program_id, application.intake_id]),
    query(`SELECT id, file_name FROM document WHERE application_id = $1 AND issued ORDER BY uploaded_at DESC LIMIT 1`, [application.id]),
    query('SELECT enrolment_date FROM enrolment WHERE application_id = $1', [application.id]),
    query('SELECT name, start_date FROM intake WHERE id = $1', [application.intake_id]),
  ]);
  return res.json({
    application: {
      status: application.status,
      submitted_date: application.submitted_date,
      offer_expires_at: application.offer_expires_at,
      offer_expired: application.offer_expires_at ? new Date(application.offer_expires_at) < new Date() : false,
      intake_name: intake.rows[0]?.name ?? null,
      ...Object.fromEntries(DETAIL_FIELDS.map((f) => [f, application[f]])),
    },
    checklist,
    intakes: intakes.rows,
    study_modes: STUDY_MODES,
    offer_letter: letter.rows[0] ?? null,
    enrolment: enrolment.rows[0] ?? null,
  });
}));

// Save the details as a draft.
router.put('/application', wrap(async (req, res) => {
  const { errors, value } = validateApplication(req.body, { requireAll: false });
  if (Object.keys(errors).length) throw invalid(errors);
  await withTransaction(async (client) => {
    const prospect = await loadProspect(client, req.user.sub, { lock: true });
    const application = await currentApplication(client, prospect.id, { lock: true });
    if (prospect.stage !== 'Qualified' || application?.status !== 'Draft') {
      throw new HttpError(409, 'Your application has already been submitted.');
    }
    if (value.intake_id) await checkIntake(client, value.intake_id, application.program_id);
    await saveDetails(client, application.id, value);
  });
  res.json({ message: 'Draft saved.' });
}));

// Uploading a document takes three requests, so the file goes straight to
// storage and never through the API (Vercel limits a request to about 4.5 MB):
//   1. POST /application/documents/upload-url  -> where to send the file
//   2. the browser PUTs the file to that address
//   3. POST /application/documents             -> the API checks the stored file and records it

/** Can this student change this document right now? Returns what the checks found. */
async function documentSlot(client, userId, documentType) {
  const prospect = await loadProspect(client, userId, { lock: true });
  const application = await currentApplication(client, prospect.id, { lock: true });
  if (!application) throw new HttpError(409, 'There is no application to add documents to.');

  const entry = (await documentChecklist(client, application)).find((c) => c.document_type === documentType);
  if (!entry) throw new HttpError(422, 'That document is not on your checklist.');

  const drafting = prospect.stage === 'Qualified' && application.status === 'Draft';
  const replacingRejected = prospect.stage === 'Application' && entry.document?.status === 'Rejected';
  if (!drafting && !replacingRejected) throw new HttpError(409, 'This document can no longer be changed.');
  return { prospect, application, entry, replacingRejected };
}

const typeOf = (body) => (typeof body?.document_type === 'string' ? body.document_type : '');

router.post('/application/documents/upload-url', wrap(async (req, res) => {
  const mimeType = typeof req.body?.mime_type === 'string' ? req.body.mime_type.toLowerCase() : '';
  const size = Number(req.body?.size_bytes);
  if (!FILE_TYPES.includes(mimeType)) throw new HttpError(415, 'Upload a PDF, JPG or PNG file.');
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(422, 'The file is empty.');
  if (size > MAX_FILE_BYTES) throw new HttpError(413, 'That file is too large. The limit is 10 MB.');

  const { application } = await withTransaction((client) => documentSlot(client, req.user.sub, typeOf(req.body)));
  const path = newStoragePath(application.id, mimeType);
  res.json({ path, ...(await createUploadTarget(path, mimeType)) });
}));

router.post('/application/documents', wrap(async (req, res) => {
  const documentType = typeOf(req.body);
  const path = req.body?.path;
  const mimeType = typeof req.body?.mime_type === 'string' ? req.body.mime_type.toLowerCase() : '';
  if (!FILE_TYPES.includes(mimeType)) throw new HttpError(415, 'Upload a PDF, JPG or PNG file.');
  const fileName = cleanFileName(req.body?.file_name, mimeType);

  // Check the file itself before recording it. A bad file is deleted again.
  const owner = await loadProspect({ query }, req.user.sub);
  const application = await currentApplication({ query }, owner.id);
  if (!application || !isApplicationPath(application.id, path)) throw new HttpError(422, 'That upload is not part of your application.');
  const file = await readFile(path);
  if (!file) throw new HttpError(422, 'The upload did not finish. Please try again.');
  const problem = file.length === 0 ? 'The file is empty.'
    : file.length > MAX_FILE_BYTES ? 'That file is too large. The limit is 10 MB.'
      : !contentMatchesType(file, mimeType) ? 'This file does not look like a real PDF, JPG or PNG. Export it again and retry.'
        : null;
  if (problem) {
    await removeFiles([path]);
    throw new HttpError(422, problem);
  }

  let replaced = null;
  await withTransaction(async (client) => {
    const { prospect, application: current, entry, replacingRejected } = await documentSlot(client, req.user.sub, documentType);
    if (current.id !== application.id) throw new HttpError(409, 'Your application changed. Please try again.');
    if ((await client.query('SELECT 1 FROM document WHERE storage_path = $1', [path])).rows.length) {
      throw new HttpError(409, 'This upload has already been recorded.');
    }
    if (entry.document) {
      replaced = (await client.query('DELETE FROM document WHERE id = $1 RETURNING storage_path', [entry.document.id])).rows[0].storage_path;
    }
    await client.query(
      `INSERT INTO document (application_id, document_type, file_name, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [current.id, documentType, fileName, mimeType, file.length, path],
    );
    await audit(client, { prospectId: prospect.id, actorType: 'student', actorId: req.user.sub, action: 'Document uploaded', detail: { document_type: documentType, file_name: fileName } });
    if (replacingRejected) {
      await ensureTask(client, { prospectId: prospect.id, staffId: prospect.assigned_staff_id, type: 'Verify documents', workingDays: 3 });
    }
  });
  await removeFiles([replaced]);
  res.status(201).json({ message: 'Uploaded.' });
}));

// A short-lived download link for one of the student's own documents (uploads or the offer letter).
router.get('/documents/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Document not found.');
  const { rows } = await query(
    `SELECT d.file_name, d.storage_path FROM document d
     JOIN application a ON a.id = d.application_id JOIN prospect p ON p.id = a.prospect_id
     WHERE d.id = $1 AND p.user_id = $2`,
    [req.params.id, req.user.sub],
  );
  if (!rows.length) throw new HttpError(404, 'Document not found.');
  res.json({ url: await createDownloadUrl(rows[0].storage_path, rows[0].file_name) });
}));

// Step 5: submit the application.
router.post('/application/submit', wrap(async (req, res) => {
  const { errors, value } = validateApplication(req.body, { requireAll: true });
  if (Object.keys(errors).length) throw invalid(errors);

  const result = await withTransaction(async (client) => {
    const prospect = await loadProspect(client, req.user.sub, { lock: true });
    const application = await currentApplication(client, prospect.id, { lock: true });
    if (prospect.stage !== 'Qualified' || application?.status !== 'Draft') {
      throw new HttpError(409, 'Your application has already been submitted.');
    }
    await checkIntake(client, value.intake_id, application.program_id);
    const missing = missingDocuments(await documentChecklist(client, application));
    if (missing.length) throw invalid({ documents: `Upload the missing documents: ${missing.join(', ')}.` });

    await saveDetails(client, application.id, value);
    await client.query(`UPDATE application SET status = 'Submitted', submitted_date = now() WHERE id = $1`, [application.id]);
    await changeStage(client, prospect.id, 'Application', { byType: 'student', byId: req.user.sub });
    await createTask(client, { prospectId: prospect.id, staffId: prospect.assigned_staff_id, type: 'Verify documents', workingDays: 3 });
    return { prospect, program: await programName(client, application.program_id) };
  });

  await sendEmail({
    prospectId: result.prospect.id,
    to: result.prospect.email,
    ...templates.applicationReceived({ name: result.prospect.full_name, program: result.program }),
  });
  res.json({ stage: 'Application' });
}));

// Step 7: accept the offer and enrol.
router.post('/offer/accept', wrap(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const prospect = await loadProspect(client, req.user.sub, { lock: true });
    const application = await currentApplication(client, prospect.id, { lock: true });
    if (prospect.stage === 'Enrolled') return null; // second click: nothing new to do
    if (prospect.stage !== 'Offer' || application?.status !== 'Accepted') {
      throw new HttpError(409, 'There is no open offer to accept.');
    }
    if (new Date(application.offer_expires_at) < new Date()) {
      throw new HttpError(409, 'This offer has expired. Please contact us.');
    }
    await client.query('INSERT INTO enrolment (application_id) VALUES ($1) ON CONFLICT (application_id) DO NOTHING', [application.id]);
    await changeStage(client, prospect.id, 'Enrolled', { byType: 'student', byId: req.user.sub });
    const intake = (await client.query('SELECT name FROM intake WHERE id = $1', [application.intake_id])).rows[0];
    return { prospect, program: await programName(client, application.program_id), intake: intake?.name };
  });

  if (result) {
    await sendEmail({
      prospectId: result.prospect.id,
      to: result.prospect.email,
      ...templates.enrolled({ name: result.prospect.full_name, program: result.program, intake: result.intake }),
    });
  }
  res.json({ stage: 'Enrolled' });
}));

router.post('/offer/decline', wrap(async (req, res) => {
  await withTransaction(async (client) => {
    const prospect = await loadProspect(client, req.user.sub, { lock: true });
    if (prospect.stage !== 'Offer') throw new HttpError(409, 'There is no open offer to decline.');
    await closeProspect(client, prospect.id, 'Offer declined', { byType: 'student', byId: req.user.sub });
  });
  res.json({ stage: 'Closed' });
}));

// Withdraw at any point before enrolment.
router.post('/withdraw', wrap(async (req, res) => {
  await withTransaction(async (client) => {
    const prospect = await loadProspect(client, req.user.sub, { lock: true });
    if (['Enrolled', 'Closed'].includes(prospect.stage)) {
      throw new HttpError(409, prospect.stage === 'Enrolled' ? 'You are already enrolled. Please contact us to make changes.' : 'This enquiry is already closed.');
    }
    await closeProspect(client, prospect.id, 'Withdrawn', { byType: 'student', byId: req.user.sub });
  });
  res.json({ stage: 'Closed' });
}));

export default router;
