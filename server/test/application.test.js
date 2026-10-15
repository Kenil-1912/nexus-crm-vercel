// Steps 5 to 7: application, documents, offer, enrolment, withdrawal, reports.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db.js';
import {
  ctx, DOC_TYPES, PDF, PNG, api, applied, details, download, emailsTo, enquire, offered, qualified, stageOf, staffLogin,
  start, stop, upload, verifyAll, prospectId,
} from './helpers.js';

let recruiter;
let manager;
before(async () => { await start(); recruiter = await staffLogin('sarah@ric.test'); manager = await staffLogin('manager@ric.test'); });
after(stop);

test('application: nothing to fill in before the student is qualified', async () => {
  const token = await enquire('early@example.com');
  assert.equal((await api('GET', '/api/student/application', null, token)).body.application, null);
  assert.equal((await upload(token, DOC_TYPES[0])).status, 409);
});

test('application: draft, upload rules, and submit needs every field and document', async () => {
  const { token, intakeId } = await qualified('apply@example.com');
  const start = await api('GET', '/api/student/application', null, token);
  assert.equal(start.body.application.status, 'Draft');
  assert.equal(start.body.application.intake_id, intakeId); // carried over from the qualification form
  assert.deepEqual(start.body.checklist.map((c) => c.document_type).sort(), [...DOC_TYPES].sort());

  assert.equal((await api('PUT', '/api/student/application', { nationality: 'Indian' }, token)).status, 200);
  assert.equal((await api('PUT', '/api/student/application', { date_of_birth: '2020-01-01' }, token)).status, 422);

  // Upload rules
  assert.equal((await upload(token, DOC_TYPES[0], { mime: 'text/plain', bytes: Buffer.from('hello') })).status, 415);
  assert.equal((await upload(token, DOC_TYPES[0], { bytes: Buffer.from('not really a pdf') })).status, 422);
  assert.equal((await upload(token, 'Bank statement')).status, 422);
  assert.equal((await upload(token, DOC_TYPES[0], { size: 11 * 1024 * 1024 })).status, 413); // declared too big
  assert.equal((await upload(token, DOC_TYPES[0], { bytes: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), size: 100 })).status, 413); // sent too big
  assert.equal((await query('SELECT count(*)::int AS n FROM local_file')).rows[0].n, 0); // the rejected fake PDF was deleted
  assert.equal((await upload(token, DOC_TYPES[0], { name: '../../etc/pass<wd>.pdf' })).status, 201);
  assert.equal((await upload(token, DOC_TYPES[0], { mime: 'image/png', bytes: PNG, name: 'passport.png' })).status, 201); // replaces
  const one = await api('GET', '/api/student/application', null, token);
  const passport = one.body.checklist.find((c) => c.document_type === DOC_TYPES[0]).document;
  assert.equal(passport.file_name, 'passport.png');
  assert.equal((await query('SELECT count(*)::int AS n FROM document')).rows[0].n, 1);
  assert.equal((await query('SELECT count(*)::int AS n FROM local_file')).rows[0].n, 1); // replaced file deleted

  // A confirmed upload cannot be recorded twice, and another application's path is refused.
  const link = await api('POST', '/api/student/application/documents/upload-url', { document_type: DOC_TYPES[1], mime_type: 'application/pdf', size_bytes: PDF.length }, token);
  await fetch(new URL(link.body.url, ctx.base), { method: 'PUT', headers: link.body.headers, body: PDF });
  const confirm = { document_type: DOC_TYPES[1], path: link.body.path, mime_type: 'application/pdf', file_name: 'a.pdf' };
  assert.equal((await api('POST', '/api/student/application/documents', confirm, token)).status, 201);
  assert.equal((await api('POST', '/api/student/application/documents', confirm, token)).status, 409);
  assert.equal((await api('POST', '/api/student/application/documents', { ...confirm, path: 'applications/00000000-0000-0000-0000-000000000000/11111111-1111-1111-1111-111111111111.pdf' }, token)).status, 422);
  const expired = link.body.url.replace(/upload\/[^/]+$/, 'upload/not-a-token');
  assert.equal((await fetch(new URL(expired, ctx.base), { method: 'PUT', headers: link.body.headers, body: PDF })).status, 403);

  // Submit: missing fields, then missing documents
  assert.ok((await api('POST', '/api/student/application/submit', { intake_id: intakeId }, token)).body.errors.date_of_birth);
  const missing = await api('POST', '/api/student/application/submit', details(intakeId), token);
  assert.equal(missing.status, 422);
  assert.match(missing.body.errors.documents, /missing documents: English test result\./);
  assert.equal((await stageOf('apply@example.com')).stage, 'Qualified');

  await upload(token, DOC_TYPES[2]);
  assert.deepEqual((await api('POST', '/api/student/application/submit', details(intakeId), token)).body, { stage: 'Application' });
  assert.equal((await upload(token, DOC_TYPES[1])).status, 409); // locked once submitted
  assert.equal((await api('PUT', '/api/student/application', { nationality: 'Indian' }, token)).status, 409);
  assert.ok((await emailsTo('apply@example.com')).includes('Application received'));
});

test('documents: only the owner and staff can download them', async () => {
  const { token } = await applied('owner@example.com');
  const other = await enquire('other@example.com');
  const doc = (await api('GET', '/api/student/application', null, token)).body.checklist[0].document;
  const mine = await download(`/api/student/documents/${doc.id}`, token);
  assert.equal(mine.status, 200);
  assert.ok(mine.bytes.equals(PDF));
  assert.equal((await download(`/api/student/documents/${doc.id}`, other)).status, 404);
  assert.equal((await download(`/api/staff/documents/${doc.id}`, token)).status, 403);
  assert.equal((await download(`/api/staff/documents/${doc.id}`, manager)).status, 200);
});

test('review: reject with a reason, student re-uploads, verify all, then accept, offer letter, enrol', async () => {
  const { token, id } = await applied('full@example.com');
  let detail = await api('GET', `/api/staff/prospects/${id}`, null, recruiter);
  assert.equal(detail.body.tasks.find((t) => t.status === 'Open').type, 'Verify documents');
  const [first] = detail.body.application.checklist;

  assert.equal((await api('POST', `/api/staff/documents/${first.document.id}/review`, { status: 'verified' }, manager)).status, 403);
  assert.equal((await api('POST', `/api/staff/documents/${first.document.id}/review`, { status: 'rejected' }, recruiter)).status, 422);
  assert.equal((await api('POST', `/api/staff/prospects/${id}/application-decision`, { decision: 'accept' }, recruiter)).status, 409);

  const rejected = await api('POST', `/api/staff/documents/${first.document.id}/review`, { status: 'rejected', reason: 'Page 2 is cut off.' }, recruiter);
  assert.deepEqual(rejected.body, { status: 'Rejected', ready_for_decision: false });
  assert.equal((await api('POST', `/api/staff/documents/${first.document.id}/review`, { status: 'verified' }, recruiter)).status, 409);
  assert.ok((await emailsTo('full@example.com')).includes('Document rejected'));

  const view = await api('GET', '/api/student/application', null, token);
  assert.equal(view.body.application.status, 'Under review');
  assert.equal(view.body.checklist[0].document.rejection_reason, 'Page 2 is cut off.');
  assert.equal((await upload(token, view.body.checklist[1].document_type)).status, 409); // only the rejected one can change
  assert.equal((await upload(token, first.document_type, { name: 'fixed.pdf' })).status, 201);

  await verifyAll(id, recruiter);
  detail = await api('GET', `/api/staff/prospects/${id}`, null, recruiter);
  assert.equal(detail.body.application.ready_for_decision, true);
  assert.deepEqual(detail.body.tasks.filter((t) => t.status === 'Open').map((t) => t.type), ['Decide application']);

  assert.equal((await api('POST', `/api/staff/prospects/${id}/application-decision`, { decision: 'accept' }, manager)).status, 403);
  assert.deepEqual((await api('POST', `/api/staff/prospects/${id}/application-decision`, { decision: 'accept' }, recruiter)).body, { stage: 'Offer' });
  assert.equal((await api('POST', `/api/staff/prospects/${id}/application-decision`, { decision: 'accept' }, recruiter)).status, 409);

  const offer = await api('GET', '/api/student/application', null, token);
  assert.equal(offer.body.application.status, 'Accepted');
  const daysLeft = (new Date(offer.body.application.offer_expires_at) - Date.now()) / 864e5;
  assert.ok(daysLeft > 13.9 && daysLeft <= 14);
  const letter = await download(`/api/student/documents/${offer.body.offer_letter.id}`, token);
  assert.equal(letter.type, 'application/pdf');
  assert.equal(letter.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(letter.bytes.length > 1000);

  assert.deepEqual((await api('POST', '/api/student/offer/accept', null, token)).body, { stage: 'Enrolled' });
  assert.deepEqual((await api('POST', '/api/student/offer/accept', null, token)).body, { stage: 'Enrolled' }); // second click
  assert.equal((await query('SELECT count(*)::int AS n FROM enrolment e JOIN application a ON a.id = e.application_id WHERE a.prospect_id = $1', [id])).rows[0].n, 1);
  assert.ok((await api('GET', '/api/student/application', null, token)).body.enrolment.enrolment_date);
  assert.equal((await api('POST', '/api/student/withdraw', null, token)).status, 409);
  assert.equal((await api('POST', `/api/staff/prospects/${id}/close`, { reason: 'Withdrawn' }, recruiter)).status, 409);

  const history = (await api('GET', `/api/staff/prospects/${id}`, null, recruiter)).body.history.map((h) => h.to_stage);
  assert.deepEqual(history, ['Enquiry', 'Qualification review', 'Qualified', 'Application', 'Offer', 'Enrolled']);
  assert.deepEqual((await emailsTo('full@example.com')).slice(-2), ['Offer', 'Enrolment confirmation']);
});

test('decision: rejecting an application needs a note and closes the record', async () => {
  const { id } = await applied('rejected@example.com');
  await verifyAll(id, recruiter);
  assert.equal((await api('POST', `/api/staff/prospects/${id}/application-decision`, { decision: 'reject' }, recruiter)).status, 422);
  const res = await api('POST', `/api/staff/prospects/${id}/application-decision`, { decision: 'reject', note: 'Transcript does not match.' }, recruiter);
  assert.deepEqual(res.body, { stage: 'Closed' });
  assert.deepEqual(await stageOf('rejected@example.com'), { stage: 'Closed', closed_reason: 'Application rejected' });
  const detail = await api('GET', `/api/staff/prospects/${id}`, null, recruiter);
  assert.equal(detail.body.application.status, 'Rejected');
  assert.equal(detail.body.tasks.filter((t) => t.status === 'Open').length, 0);
});

test('offer: declining closes the record; an expired offer cannot be accepted', async () => {
  const declined = await offered('decline@example.com', recruiter);
  assert.deepEqual((await api('POST', '/api/student/offer/decline', null, declined.token)).body, { stage: 'Closed' });
  assert.deepEqual(await stageOf('decline@example.com'), { stage: 'Closed', closed_reason: 'Offer declined' });

  const late = await offered('late@example.com', recruiter);
  await query(`UPDATE application SET offer_expires_at = now() - interval '1 hour' WHERE prospect_id = $1`, [late.id]);
  assert.equal((await api('POST', '/api/student/offer/accept', null, late.token)).status, 409);
  assert.equal((await stageOf('late@example.com')).stage, 'Offer');
});

test('withdraw: by the student, and by staff on their behalf', async () => {
  const { token } = await qualified('withdraw@example.com');
  assert.deepEqual((await api('POST', '/api/student/withdraw', null, token)).body, { stage: 'Closed' });
  assert.deepEqual(await stageOf('withdraw@example.com'), { stage: 'Closed', closed_reason: 'Withdrawn' });
  const id = await prospectId('withdraw@example.com');
  assert.equal((await query('SELECT status FROM application WHERE prospect_id = $1', [id])).rows[0].status, 'Withdrawn');
  assert.equal((await api('POST', '/api/student/withdraw', null, token)).status, 409);

  const { id: other } = await applied('staffclose@example.com');
  assert.equal((await api('POST', `/api/staff/prospects/${other}/close`, { reason: 'Because' }, recruiter)).status, 422);
  assert.equal((await api('POST', `/api/staff/prospects/${other}/close`, { reason: 'No response' }, manager)).status, 403);
  assert.deepEqual((await api('POST', `/api/staff/prospects/${other}/close`, { reason: 'No response' }, recruiter)).body, { stage: 'Closed' });
});

test('checklist: no English test result is asked from a student who took no test', async () => {
  const token = await enquire('notest@example.com');
  const me = await api('GET', '/api/student/me', null, token);
  await api('POST', '/api/student/qualification/submit', {
    highest_qualification: 'Diploma', institution: 'TAFE', year_completed: 2021, language_test_type: 'None taken', intake_id: me.body.intakes[0].id,
  }, token);
  const id = await prospectId('notest@example.com');
  await api('POST', `/api/staff/prospects/${id}/qualification-decision`, { decision: 'approve' }, await staffLogin('michael@ric.test'));
  const view = await api('GET', '/api/student/application', null, token);
  assert.deepEqual(view.body.checklist.map((c) => c.document_type), ['Academic transcript', 'Passport or photo ID']);
});

test('reports: funnel, drop-off by stage and reason, and the biggest leak', async () => {
  const res = await api('GET', '/api/staff/reports', null, manager);
  assert.equal(res.status, 200);
  const { funnel, total, enrolled, closed_reasons: reasons, biggest_leak: leak } = res.body;
  const row = (stage) => funnel.find((f) => f.stage === stage);
  assert.equal(total, (await query('SELECT count(*)::int AS n FROM prospect')).rows[0].n);
  assert.equal(row('Enquiry').entered, total);
  assert.equal(enrolled, 1);
  assert.equal(row('Enrolled').entered, 1);
  for (const f of funnel) {
    if (f.stage !== 'Enrolled') assert.equal(f.entered, f.moved_on + f.closed + f.still_here, `${f.stage} adds up`);
  }
  assert.equal(row('Application').closed, 2); // one rejected, one closed by staff
  assert.equal(row('Offer').closed, 1);
  assert.equal(row('Qualified').closed, 1);
  assert.equal(leak, 'Application');
  assert.ok(reasons.some((r) => r.stage === 'Application' && r.reason === 'Application rejected' && r.count === 1));
  assert.ok(reasons.some((r) => r.stage === 'Offer' && r.reason === 'Offer declined'));

  const none = await api('GET', '/api/staff/reports?from=2000-01-01&to=2000-12-31', null, manager);
  assert.equal(none.body.total, 0);
  assert.equal(none.body.biggest_leak, null);
  assert.equal((await api('GET', '/api/staff/reports', null, await enquire('nosy@example.com'))).status, 403);
});
