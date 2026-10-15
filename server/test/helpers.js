// Shared helpers for the API tests. start() RESETS the database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { pool, query } from '../src/db.js';

export const ctx = { base: '', programs: [] };
let server;

export async function start() {
  execFileSync('node', [fileURLToPath(new URL('../db/reset.js', import.meta.url))]);
  server = createApp().listen(0);
  ctx.base = `http://localhost:${server.address().port}`;
  ctx.programs = (await api('GET', '/api/programs')).body;
}
export async function stop() {
  server.close();
  await pool.end();
}

export async function api(method, path, body, token) {
  const res = await fetch(ctx.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

export const PDF = Buffer.from('%PDF-1.4\n% test file\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
export const DOC_TYPES = ['Passport or photo ID', 'Academic transcript', 'English test result'];

/** The browser's three-step upload: ask for a link, send the file, confirm. */
export async function upload(token, type, { mime = 'application/pdf', bytes = PDF, name = 'file.pdf', size } = {}) {
  const link = await api('POST', '/api/student/application/documents/upload-url',
    { document_type: type, mime_type: mime, size_bytes: size ?? bytes.length }, token);
  if (link.status !== 200) return link;
  const put = await fetch(new URL(link.body.url, ctx.base), { method: 'PUT', headers: link.body.headers, body: bytes });
  if (!put.ok) return { status: put.status, body: await put.json() };
  return api('POST', '/api/student/application/documents', { document_type: type, path: link.body.path, mime_type: mime, file_name: name }, token);
}

/** Ask the API for a download link, then follow it. */
export async function download(path, token) {
  const link = await api('GET', path, null, token);
  if (link.status !== 200) return { status: link.status };
  const res = await fetch(new URL(link.body.url, ctx.base));
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}

export const staffLogin = async (email) => (await api('POST', '/api/auth/staff/login', { email, password: 'Password123!' })).body.token;
export const prospectId = async (email) => (await query('SELECT id FROM prospect WHERE email = $1', [email])).rows[0].id;
export const stageOf = async (email) => (await query('SELECT stage, closed_reason FROM prospect WHERE email = $1', [email])).rows[0];
export const emailsTo = async (email) => (await query('SELECT template FROM email_log WHERE to_email = $1 ORDER BY sent_at', [email])).rows.map((r) => r.template);

let counter = 0;
const program = (name) => ctx.programs.find((p) => p.name.includes(name)).id;

/** Enquire with a password. Returns the student's token. Stage: Enquiry. */
export async function enquire(email, { programName = 'Data Science' } = {}) {
  counter += 1;
  const res = await api('POST', '/api/enquiries', {
    full_name: 'Test Student', email, phone: `04${String(10000000 + counter)}`, program_id: program(programName),
    consent: true, password: 'correct-horse-battery',
  });
  assert.equal(res.status, 201);
  return res.body.token;
}

/** Enquire and pass the criteria check. Stage: Qualified. */
export async function qualified(email, overrides = {}) {
  const token = await enquire(email);
  const me = await api('GET', '/api/student/me', null, token);
  const res = await api('POST', '/api/student/qualification/submit', {
    highest_qualification: 'Diploma', institution: 'Sydney TAFE', year_completed: 2022,
    language_test_type: 'IELTS', language_score: 7, test_date: new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10),
    intake_id: me.body.intakes[0].id, ...overrides,
  }, token);
  assert.equal(res.status, 200);
  return { token, intakeId: me.body.intakes[0].id };
}

export const details = (intakeId, overrides = {}) => ({
  date_of_birth: '2000-05-17', nationality: 'Australian', emergency_contact_name: 'Sam Student',
  emergency_contact_phone: '0400 111 222', study_mode: 'Online', intake_id: intakeId, ...overrides,
});

/** Qualified, all documents uploaded, application submitted. Stage: Application. */
export async function applied(email) {
  const { token, intakeId } = await qualified(email);
  for (const type of DOC_TYPES) assert.equal((await upload(token, type)).status, 201);
  const res = await api('POST', '/api/student/application/submit', details(intakeId), token);
  assert.deepEqual(res.body, { stage: 'Application' });
  return { token, intakeId, id: await prospectId(email) };
}

/** Verify every pending document for a prospect. */
export async function verifyAll(id, recruiter) {
  const detail = await api('GET', `/api/staff/prospects/${id}`, null, recruiter);
  for (const item of detail.body.application.checklist) {
    if (item.document?.status === 'Pending') {
      assert.equal((await api('POST', `/api/staff/documents/${item.document.id}/review`, { status: 'verified' }, recruiter)).status, 200);
    }
  }
}

/** Application accepted, offer letter issued. Stage: Offer. */
export async function offered(email, recruiter) {
  const student = await applied(email);
  await verifyAll(student.id, recruiter);
  const res = await api('POST', `/api/staff/prospects/${student.id}/application-decision`, { decision: 'accept' }, recruiter);
  assert.deepEqual(res.body, { stage: 'Offer' });
  return student;
}
