// Staff side of steps 5 to 7: document review, application decision and offer,
// closing a record, pipeline reports, and running the daily checks on demand.
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { HttpError, audit, changeStage, closeProspect, completeTasks, ensureTask } from '../pipeline.js';
import { isUuid } from '../validate.js';
import {
  OFFER_DAYS, allRequiredVerified, anyPending, currentApplication, documentChecklist, newStoragePath,
} from '../application.js';
import { createDownloadUrl, removeFiles, writeFile } from '../storage.js';
import { formatLongDate, offerLetterPdf } from '../offerLetter.js';
import { runDailyJobs } from '../jobs.js';
import { sendEmail, templates } from '../mailer.js';

const router = Router();
router.use(requireAuth('staff'));
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const noteOf = (body) => (typeof body?.note === 'string' ? body.note.trim() : '');

// Returns a short-lived download link for any document.
router.get('/documents/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'Document not found.');
  const { rows } = await query('SELECT file_name, storage_path FROM document WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Document not found.');
  res.json({ url: await createDownloadUrl(rows[0].storage_path, rows[0].file_name) });
}));

// Step 5, staff: verify or reject one uploaded document.
router.post('/documents/:id/review', requireRole('recruiter'), wrap(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw new HttpError(404, 'Document not found.');
  const verified = req.body?.status === 'verified';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!verified && req.body?.status !== 'rejected') throw new HttpError(422, 'Choose verified or rejected.');
  if (!verified && !reason) throw new HttpError(422, 'Say why the document is rejected.', { errors: { reason: 'The student sees this reason, so say what to fix.' } });
  if (reason.length > 500) throw new HttpError(422, 'Reason must be 500 characters or fewer.');

  const result = await withTransaction(async (client) => {
    const doc = (await client.query(
      `SELECT d.id, d.document_type, d.status, d.issued, a.id AS application_id, a.prospect_id
       FROM document d JOIN application a ON a.id = d.application_id WHERE d.id = $1 FOR UPDATE OF d, a`, [id],
    )).rows[0];
    if (!doc || doc.issued) throw new HttpError(404, 'Document not found.');
    const prospect = (await client.query(
      'SELECT id, full_name, email, stage, assigned_staff_id FROM prospect WHERE id = $1 FOR UPDATE', [doc.prospect_id],
    )).rows[0];
    const application = await currentApplication(client, prospect.id);
    if (prospect.stage !== 'Application' || application.id !== doc.application_id) {
      throw new HttpError(409, 'This application is not being reviewed at the moment.');
    }
    if (doc.status !== 'Pending') throw new HttpError(409, `This document has already been ${doc.status.toLowerCase()}.`);

    await client.query(
      `UPDATE document SET status = $2, rejection_reason = $3, verified_by = $4, verified_at = now() WHERE id = $1`,
      [id, verified ? 'Verified' : 'Rejected', verified ? null : reason, req.user.sub],
    );
    await client.query(`UPDATE application SET status = 'Under review' WHERE id = $1 AND status = 'Submitted'`, [application.id]);
    await audit(client, {
      prospectId: prospect.id, actorType: 'staff', actorId: req.user.sub,
      action: `Document ${verified ? 'verified' : 'rejected'}`, detail: { document_type: doc.document_type, reason: reason || null },
    });

    // Nothing left to check: close the verification task. If everything is
    // verified, the application is ready for a decision.
    const checklist = await documentChecklist(client, application);
    const ready = allRequiredVerified(checklist);
    if (!anyPending(checklist)) await completeTasks(client, prospect.id, ['Verify documents']);
    if (ready) await ensureTask(client, { prospectId: prospect.id, staffId: prospect.assigned_staff_id, type: 'Decide application', workingDays: 1 });
    return { prospect, documentType: doc.document_type, ready };
  });

  if (!verified) {
    await sendEmail({
      prospectId: result.prospect.id,
      to: result.prospect.email,
      ...templates.documentRejected({ name: result.prospect.full_name, documentType: result.documentType, reason }),
    });
  }
  res.json({ status: verified ? 'Verified' : 'Rejected', ready_for_decision: result.ready });
}));

// Step 6: accept (issue the offer letter) or reject the application.
router.post('/prospects/:id/application-decision', requireRole('recruiter'), wrap(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw new HttpError(404, 'Prospect not found.');
  const accept = req.body?.decision === 'accept';
  const note = noteOf(req.body);
  if (!accept && req.body?.decision !== 'reject') throw new HttpError(422, 'Choose accept or reject.');
  if (!accept && !note) throw new HttpError(422, 'A note is required when rejecting.', { errors: { note: 'Explain why the application is rejected.' } });
  if (note.length > 1000) throw new HttpError(422, 'Note must be 1,000 characters or fewer.');

  let letterPath = null;
  const result = await withTransaction(async (client) => {
    const prospect = (await client.query('SELECT id, full_name, email, address, stage FROM prospect WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!prospect) throw new HttpError(404, 'Prospect not found.');
    if (prospect.stage !== 'Application') {
      throw new HttpError(409, `This record is in "${prospect.stage}" and is not waiting for an application decision.`);
    }
    const application = await currentApplication(client, id, { lock: true });
    const details = (await client.query(
      `SELECT g.name AS program, i.name AS intake, i.start_date FROM program g LEFT JOIN intake i ON i.id = $2 WHERE g.id = $1`,
      [application.program_id, application.intake_id],
    )).rows[0];
    const by = { byType: 'staff', byId: req.user.sub };
    let expires = null;

    if (accept) {
      if (!allRequiredVerified(await documentChecklist(client, application))) {
        throw new HttpError(409, 'Every required document must be verified before an offer can be made.');
      }
      expires = new Date(Date.now() + OFFER_DAYS * 864e5);
      // If the PDF cannot be built this throws, and the whole decision rolls back:
      // nobody ends up in Offer without a letter.
      const pdf = await offerLetterPdf({
        name: prospect.full_name, address: prospect.address, program: details.program, intake: details.intake,
        intakeStart: details.start_date, studyMode: application.study_mode, offerDate: new Date(), expires,
      });
      // Stored before the transaction commits: if storing fails, nothing changes.
      letterPath = newStoragePath(application.id, 'application/pdf');
      await writeFile(letterPath, pdf, 'application/pdf');
      await client.query(
        `INSERT INTO document (application_id, document_type, issued, file_name, mime_type, size_bytes, storage_path, status, verified_by, verified_at)
         VALUES ($1, 'Offer letter', TRUE, 'Offer letter.pdf', 'application/pdf', $2, $3, 'Verified', $4, now())`,
        [application.id, pdf.length, letterPath, req.user.sub],
      );
      await client.query(
        `UPDATE application SET status = 'Accepted', decision_by = $2, decision_note = $3, decided_at = now(), offer_expires_at = $4 WHERE id = $1`,
        [application.id, req.user.sub, note || null, expires],
      );
      await changeStage(client, id, 'Offer', by);
      await completeTasks(client, id);
    } else {
      await client.query(
        `UPDATE application SET status = 'Rejected', decision_by = $2, decision_note = $3, decided_at = now() WHERE id = $1`,
        [application.id, req.user.sub, note],
      );
      await closeProspect(client, id, 'Application rejected', by);
    }
    await audit(client, { prospectId: id, actorType: 'staff', actorId: req.user.sub, action: `Application ${accept ? 'accepted' : 'rejected'}`, detail: { note: note || null } });
    return { prospect, program: details.program, expires };
  }).catch(async (err) => {
    await removeFiles([letterPath]); // the decision rolled back, so drop the letter too
    throw err;
  });

  const data = { name: result.prospect.full_name, program: result.program };
  await sendEmail({
    prospectId: id,
    to: result.prospect.email,
    ...(accept ? templates.offer({ ...data, expires: formatLongDate(result.expires) }) : templates.applicationRejected(data)),
  });
  res.json({ stage: accept ? 'Offer' : 'Closed' });
}));

// Close a record on the student's behalf.
router.post('/prospects/:id/close', requireRole('recruiter'), wrap(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw new HttpError(404, 'Prospect not found.');
  const reason = req.body?.reason;
  if (!['Withdrawn', 'No response'].includes(reason)) throw new HttpError(422, 'Choose a reason: Withdrawn or No response.');
  await withTransaction(async (client) => {
    const prospect = (await client.query('SELECT stage FROM prospect WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!prospect) throw new HttpError(404, 'Prospect not found.');
    if (['Enrolled', 'Closed'].includes(prospect.stage)) throw new HttpError(409, `A record in "${prospect.stage}" cannot be closed.`);
    await closeProspect(client, id, reason, { byType: 'staff', byId: req.user.sub });
  });
  res.json({ stage: 'Closed' });
}));

// Pipeline report: where prospects go at each stage, built from stage_history.
const FUNNEL = ['Enquiry', 'Qualification review', 'Qualified', 'Application', 'Offer', 'Enrolled'];
const dateParam = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

router.get('/reports', wrap(async (req, res) => {
  const from = dateParam(req.query.from);
  const to = dateParam(req.query.to);
  const cohort = `SELECT id, stage FROM prospect
                  WHERE ($1::date IS NULL OR created_at >= $1::date) AND ($2::date IS NULL OR created_at < $2::date + 1)`;
  const params = [from, to];

  const [entered, left, current, time, total] = await Promise.all([
    query(`SELECT h.to_stage AS stage, count(DISTINCT h.prospect_id)::int AS n
           FROM stage_history h JOIN (${cohort}) c ON c.id = h.prospect_id GROUP BY h.to_stage`, params),
    query(`SELECT h.from_stage AS stage, h.to_stage = 'Closed' AS closed, h.closed_reason AS reason, count(DISTINCT h.prospect_id)::int AS n
           FROM stage_history h JOIN (${cohort}) c ON c.id = h.prospect_id
           WHERE h.from_stage IS NOT NULL AND h.from_stage <> 'Closed' GROUP BY 1, 2, 3`, params),
    query(`SELECT stage, count(*)::int AS n FROM (${cohort}) c GROUP BY stage`, params),
    query(`SELECT stage, round(avg(days)::numeric, 1)::float AS avg_days FROM (
             SELECT h.to_stage AS stage,
                    extract(epoch FROM lead(h.changed_at) OVER (PARTITION BY h.prospect_id ORDER BY h.changed_at) - h.changed_at) / 86400 AS days
             FROM stage_history h JOIN (${cohort}) c ON c.id = h.prospect_id) x
           WHERE days IS NOT NULL AND stage <> 'Closed' GROUP BY stage`, params),
    query(`SELECT count(*)::int AS n FROM (${cohort}) c`, params),
  ]);

  const pick = (rows, stage) => rows.find((r) => r.stage === stage);
  const funnel = FUNNEL.map((stage) => {
    const enteredCount = pick(entered.rows, stage)?.n ?? 0;
    const closed = left.rows.filter((r) => r.stage === stage && r.closed).reduce((sum, r) => sum + r.n, 0);
    const movedOn = left.rows.filter((r) => r.stage === stage && !r.closed).reduce((sum, r) => sum + r.n, 0);
    return {
      stage,
      entered: enteredCount,
      moved_on: movedOn,
      closed,
      still_here: pick(current.rows, stage)?.n ?? 0,
      drop_off_rate: enteredCount ? Math.round((closed / enteredCount) * 1000) / 10 : null,
      avg_days: pick(time.rows, stage)?.avg_days ?? null,
    };
  });
  const leaks = funnel.filter((f) => f.closed > 0).sort((a, b) => b.closed - a.closed || b.drop_off_rate - a.drop_off_rate);

  res.json({
    from, to,
    total: total.rows[0].n,
    enrolled: pick(current.rows, 'Enrolled')?.n ?? 0,
    funnel,
    biggest_leak: leaks[0]?.stage ?? null,
    closed_reasons: left.rows.filter((r) => r.closed).map((r) => ({ stage: r.stage, reason: r.reason, count: r.n }))
      .sort((a, b) => FUNNEL.indexOf(a.stage) - FUNNEL.indexOf(b.stage) || b.count - a.count),
  });
}));

// Run the reminder and auto-close checks now (they also run on a timer).
router.post('/jobs/run', requireRole('manager'), wrap(async (_req, res) => {
  res.json(await runDailyJobs());
}));

export default router;
