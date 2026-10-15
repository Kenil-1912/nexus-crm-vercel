// File storage for uploaded documents and offer letters.
//
// Two drivers with the same interface:
//  - "supabase": a private Supabase Storage bucket (used on Vercel). The browser
//    uploads straight to Supabase through a signed URL, so files never pass
//    through the API (Vercel limits a request to about 4.5 MB).
//  - "local": files kept in the local_file table, uploaded and downloaded
//    through /api/storage/local/... with short-lived signed tokens. Used for
//    local development and the tests, so nothing needs Supabase to run.
//
// The driver is "supabase" when SUPABASE_URL is set, otherwise "local".
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { query } from './db.js';

export const BUCKET = process.env.SUPABASE_BUCKET || 'documents';
export const usingSupabase = () => Boolean(process.env.SUPABASE_URL);

const secret = () => process.env.JWT_SECRET || 'dev-only-secret';

let supabase;
function bucket() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  supabase ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase.storage.from(BUCKET);
}

const fail = (action, error) => {
  const err = new Error(`Storage ${action} failed: ${error?.message || error}`);
  err.storageError = error;
  return err;
};

/**
 * Where the browser should send a new file. Returns { url, headers }:
 * the browser sends the file as the body of a PUT to url with those headers.
 */
export async function createUploadTarget(path, mimeType) {
  if (usingSupabase()) {
    const { data, error } = await bucket().createSignedUploadUrl(path);
    if (error) throw fail('upload link', error);
    return { url: data.signedUrl, headers: { 'Content-Type': mimeType, 'x-upsert': 'false' } };
  }
  const token = jwt.sign({ kind: 'upload', path, mime: mimeType }, secret(), { expiresIn: '15m' });
  return { url: `/api/storage/local/upload/${token}`, headers: { 'Content-Type': mimeType } };
}

/** Read a stored file. Returns a Buffer, or null if there is no such file. */
export async function readFile(path) {
  if (usingSupabase()) {
    const { data, error } = await bucket().download(path);
    if (error) {
      if (error.status === 400 || error.status === 404 || error.statusCode === '404' || /not.?found/i.test(error.message)) return null;
      throw fail('read', error);
    }
    return Buffer.from(await data.arrayBuffer());
  }
  const { rows } = await query('SELECT content FROM local_file WHERE path = $1', [path]);
  return rows[0]?.content ?? null;
}

/** Store a file created by the server (the offer letter). */
export async function writeFile(path, buffer, mimeType) {
  if (usingSupabase()) {
    const { error } = await bucket().upload(path, buffer, { contentType: mimeType, upsert: true });
    if (error) throw fail('write', error);
    return;
  }
  await query(
    `INSERT INTO local_file (path, mime_type, content) VALUES ($1, $2, $3)
     ON CONFLICT (path) DO UPDATE SET mime_type = EXCLUDED.mime_type, content = EXCLUDED.content`,
    [path, mimeType, buffer],
  );
}

/** Delete files. Never throws: a leftover file is better than a failed request. */
export async function removeFiles(paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  try {
    if (usingSupabase()) {
      const { error } = await bucket().remove(list);
      if (error) throw error;
    } else {
      await query('DELETE FROM local_file WHERE path = ANY($1)', [list]);
    }
  } catch (err) {
    console.error(`Could not delete stored files ${list.join(', ')}: ${err.message}`);
  }
}

/** A link that downloads the file for about a minute. */
export async function createDownloadUrl(path, fileName) {
  if (usingSupabase()) {
    const { data, error } = await bucket().createSignedUrl(path, 60, { download: fileName });
    if (error) throw fail('download link', error);
    return data.signedUrl;
  }
  const token = jwt.sign({ kind: 'download', path, name: fileName }, secret(), { expiresIn: '60s' });
  return `/api/storage/local/download/${token}`;
}

/** Check a local-driver token. Returns its payload, or null. */
export function readLocalToken(token, kind) {
  try {
    const payload = jwt.verify(token, secret());
    return payload.kind === kind ? payload : null;
  } catch {
    return null;
  }
}

/** Create the private bucket if it does not exist yet (run by db:reset). */
export async function prepareBucket({ empty = false } = {}) {
  if (!usingSupabase()) return 'local';
  bucket();
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  });
  if (error && !/already exists|duplicate/i.test(error.message)) throw fail('bucket setup', error);
  if (empty) {
    const { error: emptyError } = await supabase.storage.emptyBucket(BUCKET);
    if (emptyError) throw fail('emptying the bucket', emptyError);
  }
  return 'supabase';
}
