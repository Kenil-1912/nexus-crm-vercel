// Small fetch wrapper. Tokens live in sessionStorage, so closing the tab logs out.

export const session = {
  get: (kind) => {
    try { return JSON.parse(sessionStorage.getItem(`nexus_${kind}`)); } catch { return null; }
  },
  set: (kind, value) => sessionStorage.setItem(`nexus_${kind}`, JSON.stringify(value)),
  clear: (kind) => sessionStorage.removeItem(`nexus_${kind}`),
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || 'Something went wrong. Please try again.');
    this.status = status;
    this.errors = body?.errors || {};
  }
}

/** kind: 'student' | 'staff' | undefined (public). */
export async function api(path, { method = 'GET', body, kind } = {}) {
  const token = kind ? session.get(kind)?.token : null;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { message: 'Cannot reach the server. Check your connection and try again.' });
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && kind) {
    session.clear(kind);
    window.location.assign(kind === 'staff' ? '/staff/login' : '/login');
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
export const formatDateTime = (value) =>
  value ? new Date(value).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Upload one application document (student) in three steps: ask the API where
 * to send the file, send it straight to storage, then ask the API to record it.
 */
export async function uploadDocument(documentType, file) {
  if (!FILE_TYPES.includes(file.type)) throw new ApiError(415, { message: 'Upload a PDF, JPG or PNG file.' });
  if (file.size > MAX_FILE_BYTES) throw new ApiError(413, { message: 'That file is too large. The limit is 10 MB.' });
  const meta = { document_type: documentType, mime_type: file.type, size_bytes: file.size };
  const target = await api('/student/application/documents/upload-url', { method: 'POST', body: meta, kind: 'student' });

  let res;
  try {
    res = await fetch(target.url, { method: 'PUT', headers: target.headers, body: file });
  } catch {
    throw new ApiError(0, { message: 'The upload could not reach storage. Check your connection and try again.' });
  }
  if (!res.ok) throw new ApiError(res.status, { message: 'The upload failed. Please try again.' });

  return api('/student/application/documents', {
    method: 'POST', kind: 'student', body: { ...meta, path: target.path, file_name: file.name },
  });
}

/** Download a document: the API returns a short-lived link, which the browser then opens. */
export async function downloadDocument(id, kind) {
  const { url } = await api(`/${kind}/documents/${id}`, { kind });
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export const formatSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
