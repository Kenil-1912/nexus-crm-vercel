// Daily checks: reminders, automatic closures, overdue-task escalation.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db.js';
import { runDailyJobs } from '../src/jobs.js';
import { ctx, api, applied, emailsTo, enquire, offered, qualified, stageOf, staffLogin, start, stop } from './helpers.js';

const inDays = (n) => new Date(Date.now() + n * 864e5);
const count = (list, item) => list.filter((x) => x === item).length;
let recruiter;
before(async () => { await start(); recruiter = await staffLogin('sarah@ric.test'); });
after(stop);

test('nothing happens on day 0, and running twice sends nothing twice', async () => {
  await enquire('enquiry@example.com');
  await qualified('qualified@example.com');
  await offered('offer@example.com', recruiter);
  const { id } = await applied('docs@example.com');
  const doc = (await api('GET', `/api/staff/prospects/${id}`, null, recruiter)).body.application.checklist[0].document;
  await api('POST', `/api/staff/documents/${doc.id}/review`, { status: 'rejected', reason: 'Blurry.' }, recruiter);

  assert.deepEqual(await runDailyJobs(), { reminders: 0, closed: 0, escalated: 0 });
});

test('reminders go out once at the right time', async () => {
  assert.equal((await runDailyJobs(inDays(4))).reminders, 1); // enquiry only (3 days)
  assert.equal(count(await emailsTo('enquiry@example.com'), 'Details reminder'), 1);

  const day8 = await runDailyJobs(inDays(8)); // application (7), document (5), offer (7 days before expiry)
  assert.equal(day8.reminders, 3);
  assert.equal(day8.closed, 0);
  assert.equal(count(await emailsTo('qualified@example.com'), 'Application reminder'), 1);
  assert.equal(count(await emailsTo('docs@example.com'), 'Document reminder'), 1);
  assert.equal(count(await emailsTo('offer@example.com'), 'Offer reminder'), 1);

  assert.equal((await runDailyJobs(inDays(9))).reminders, 0); // already sent
  assert.equal(count(await emailsTo('enquiry@example.com'), 'Details reminder'), 1);
});

test('overdue tasks are escalated to the manager once', async () => {
  // The "Verify documents" task (due in 3 working days) was 2 working days
  // overdue by the day-8 run above, so it has been escalated already.
  const escalated = (await query('SELECT type FROM task WHERE escalated_at IS NOT NULL')).rows;
  assert.deepEqual(escalated, [{ type: 'Verify documents' }]);
  assert.equal(count(await emailsTo('manager@ric.test'), 'Task escalation'), 1);
  assert.equal((await runDailyJobs(inDays(12))).escalated, 0);
  assert.equal(count(await emailsTo('manager@ric.test'), 'Task escalation'), 1);
});

test('records are closed with the right reason when the time runs out', async () => {
  await runDailyJobs(inDays(15));
  assert.deepEqual(await stageOf('enquiry@example.com'), { stage: 'Closed', closed_reason: 'No response' });
  assert.deepEqual(await stageOf('offer@example.com'), { stage: 'Closed', closed_reason: 'Offer lapsed' });
  assert.equal((await stageOf('qualified@example.com')).stage, 'Qualified');
  assert.equal((await stageOf('docs@example.com')).stage, 'Application');
  assert.ok((await emailsTo('offer@example.com')).includes('Offer lapsed'));

  await runDailyJobs(inDays(22));
  assert.deepEqual(await stageOf('docs@example.com'), { stage: 'Closed', closed_reason: 'No response' });
  await runDailyJobs(inDays(31));
  assert.deepEqual(await stageOf('qualified@example.com'), { stage: 'Closed', closed_reason: 'No response' });

  const live = (await query(`SELECT count(*)::int AS n FROM application WHERE status NOT IN ('Withdrawn', 'Rejected')`)).rows[0].n;
  assert.equal(live, 0);
  assert.equal((await query(`SELECT count(*)::int AS n FROM task WHERE status = 'Open'`)).rows[0].n, 0);
  assert.deepEqual(await runDailyJobs(inDays(60)), { reminders: 0, closed: 0, escalated: 0 });
});

test('cron endpoint: needs the CRON_SECRET bearer token', async () => {
  const call = (auth) => fetch(`${ctx.base}/api/cron/daily-jobs`, { headers: auth ? { Authorization: auth } : {} });
  delete process.env.CRON_SECRET;
  assert.equal((await call('Bearer anything')).status, 401); // no secret configured: always refused
  process.env.CRON_SECRET = 'test-cron-secret';
  assert.equal((await call()).status, 401);
  assert.equal((await call('Bearer wrong')).status, 401);
  const ok = await call('Bearer test-cron-secret');
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(await ok.json()).sort(), ['closed', 'escalated', 'reminders']);
});
