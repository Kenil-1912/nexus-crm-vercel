// Shared application and document helpers used by the student and staff routes.
import crypto from 'node:crypto';
import { NO_TEST } from './criteria.js';

export const STUDY_MODES = ['On campus', 'Online', 'Blended'];
export const OFFER_DAYS = 14;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const ENGLISH_DOCUMENT = 'English test result';

/** The prospect's current application: the most recent one. */
export async function currentApplication(client, prospectId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM application WHERE prospect_id = $1 ORDER BY created_at DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [prospectId],
  );
  return rows[0] ?? null;
}

/**
 * The document checklist for an application: one entry per document type the
 * program asks for, with the student's upload if there is one. A student who
 * told us they have taken no language test is not asked for a test result.
 */
export async function documentChecklist(client, application) {
  const { rows } = await client.query(
    `SELECT t.document_type, t.is_required,
            d.id, d.file_name, d.mime_type, d.size_bytes, d.status, d.rejection_reason, d.uploaded_at, d.verified_at,
            s.full_name AS verified_by_name
     FROM program_document_type t
     LEFT JOIN document d ON d.application_id = $1 AND d.document_type = t.document_type AND NOT d.issued
     LEFT JOIN staff_user s ON s.id = d.verified_by
     WHERE t.program_id = $2 ORDER BY t.document_type`,
    [application.id, application.program_id],
  );
  const noTest = (await client.query(
    'SELECT 1 FROM qualification WHERE prospect_id = $1 AND language_test_type = $2', [application.prospect_id, NO_TEST],
  )).rows.length > 0;

  return rows
    .filter((r) => !(noTest && r.document_type === ENGLISH_DOCUMENT))
    .map((r) => ({
      document_type: r.document_type,
      required: r.is_required,
      document: r.id ? {
        id: r.id, file_name: r.file_name, mime_type: r.mime_type, size_bytes: r.size_bytes, status: r.status,
        rejection_reason: r.rejection_reason, uploaded_at: r.uploaded_at, verified_at: r.verified_at, verified_by_name: r.verified_by_name,
      } : null,
    }));
}

export const missingDocuments = (checklist) => checklist.filter((c) => c.required && !c.document).map((c) => c.document_type);
export const allRequiredVerified = (checklist) => checklist.every((c) => !c.required || c.document?.status === 'Verified');
export const anyPending = (checklist) => checklist.some((c) => c.document?.status === 'Pending');

/** Check the first bytes of a file really match the type it claims to be. */
export function contentMatchesType(buffer, mimeType) {
  const starts = (bytes) => bytes.every((b, i) => buffer[i] === b);
  if (mimeType === 'application/pdf') return starts([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  if (mimeType === 'image/jpeg') return starts([0xff, 0xd8, 0xff]);
  if (mimeType === 'image/png') return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return false;
}

/** Keep only a safe base name for display and download. */
export function cleanFileName(raw, mimeType) {
  let name = '';
  try { name = decodeURIComponent(String(raw || '')); } catch { name = ''; }
  name = name.split(/[\\/]/).pop().replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 120);
  const extension = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[mimeType];
  return name || `document${extension}`;
}

const EXTENSIONS = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** A new, unguessable storage path for a file that belongs to an application. */
export const newStoragePath = (applicationId, mimeType) =>
  `applications/${applicationId}/${crypto.randomUUID()}.${EXTENSIONS[mimeType]}`;

/** True if path is one this application's upload link could have created. */
export const isApplicationPath = (applicationId, path) =>
  typeof path === 'string'
  && new RegExp(`^applications/${applicationId}/[0-9a-f-]{36}\\.(pdf|jpg|png)$`).test(path);
