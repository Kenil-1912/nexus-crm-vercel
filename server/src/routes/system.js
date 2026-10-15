// System routes: the local storage stand-in, and the daily checks called by Vercel Cron.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { query } from '../db.js';
import { HttpError } from '../pipeline.js';
import { readLocalToken, usingSupabase } from '../storage.js';
import { MAX_FILE_BYTES } from '../application.js';
import { runDailyJobs } from '../jobs.js';

const router = Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// ---- Local storage (only when Supabase is not configured) ----
const localOnly = (_req, _res, next) => (usingSupabase() ? next(new HttpError(404, 'Not found.')) : next());

router.put(
  '/storage/local/upload/:token',
  localOnly,
  express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
  wrap(async (req, res) => {
    const target = readLocalToken(req.params.token, 'upload');
    if (!target) throw new HttpError(403, 'This upload link has expired. Try again.');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(422, 'The file is empty.');
    await query(
      `INSERT INTO local_file (path, mime_type, content) VALUES ($1, $2, $3)
       ON CONFLICT (path) DO UPDATE SET mime_type = EXCLUDED.mime_type, content = EXCLUDED.content`,
      [target.path, target.mime, req.body],
    );
    res.json({ Key: target.path });
  }),
);

router.get('/storage/local/download/:token', localOnly, wrap(async (req, res) => {
  const target = readLocalToken(req.params.token, 'download');
  if (!target) throw new HttpError(403, 'This download link has expired. Try again.');
  const { rows } = await query('SELECT mime_type, content FROM local_file WHERE path = $1', [target.path]);
  if (!rows.length) throw new HttpError(404, 'File not found.');
  res.set({
    'Content-Type': rows[0].mime_type,
    'Content-Length': rows[0].content.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(target.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.send(rows[0].content);
}));

// ---- Daily checks, called by Vercel Cron ----
// Vercel sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
function cronAllowed(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const given = Buffer.from(req.headers.authorization || '');
  const wanted = Buffer.from(`Bearer ${expected}`);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

router.get('/cron/daily-jobs', wrap(async (req, res) => {
  if (!cronAllowed(req)) throw new HttpError(401, 'Not allowed.');
  res.json(await runDailyJobs());
}));

export default router;
