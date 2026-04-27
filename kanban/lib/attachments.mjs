import fs from 'node:fs';
import path from 'node:path';
import { findTask } from './repo.mjs';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const MIME = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.bmp':  'image/bmp',
};

function safeName(name) {
  // drop path components, replace odd chars
  let n = path.basename(String(name || ''));
  n = n.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!n) n = 'file';
  if (n.length > 80) n = n.slice(-80);
  return n;
}

function attachmentsDir(taskPath, tid) {
  return path.join(path.dirname(taskPath), '_attachments', tid);
}

export function listAttachments(tid) {
  const [p] = findTask(tid);
  if (!p) return null;
  const dir = attachmentsDir(p, tid);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const n of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, n);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    const ext = path.extname(n).toLowerCase();
    out.push({
      name: n,
      size: st.size,
      type: MIME[ext] || 'application/octet-stream',
      url:  `/api/task/${encodeURIComponent(tid)}/attachments/${encodeURIComponent(n)}`,
    });
  }
  return out;
}

export function saveAttachment(tid, rawName, dataBase64) {
  const [p] = findTask(tid);
  if (!p) return { error: 'task not found', code: 404 };
  const name = safeName(rawName);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { error: `extension ${ext || '(none)'} not allowed`, code: 400 };
  let buf;
  try { buf = Buffer.from(String(dataBase64 || ''), 'base64'); }
  catch { return { error: 'invalid base64', code: 400 }; }
  if (!buf.length) return { error: 'empty file', code: 400 };
  if (buf.length > MAX_BYTES) return { error: `file too large (${buf.length} > ${MAX_BYTES})`, code: 413 };

  const dir = attachmentsDir(p, tid);
  fs.mkdirSync(dir, { recursive: true });
  // avoid overwriting: if file exists, append numeric suffix
  let target = path.join(dir, name);
  if (fs.existsSync(target)) {
    const base = name.replace(/(\.[^.]+)?$/, '');
    let i = 2;
    while (fs.existsSync(path.join(dir, `${base}-${i}${ext}`))) i++;
    target = path.join(dir, `${base}-${i}${ext}`);
  }
  fs.writeFileSync(target, buf);
  const finalName = path.basename(target);
  return {
    item: {
      name: finalName,
      size: buf.length,
      type: MIME[ext] || 'application/octet-stream',
      url:  `/api/task/${encodeURIComponent(tid)}/attachments/${encodeURIComponent(finalName)}`,
    },
  };
}

export function deleteAttachment(tid, rawName) {
  const [p] = findTask(tid);
  if (!p) return { code: 404, error: 'task not found' };
  const name = safeName(rawName);
  const dir = attachmentsDir(p, tid);
  const full = path.join(dir, name);
  if (!full.startsWith(dir)) return { code: 403, error: 'forbidden' };
  if (!fs.existsSync(full)) return { code: 404, error: 'attachment not found' };
  fs.unlinkSync(full);
  return { ok: true };
}

export function readAttachment(tid, rawName) {
  const [p] = findTask(tid);
  if (!p) return null;
  const name = safeName(rawName);
  const dir = attachmentsDir(p, tid);
  const full = path.join(dir, name);
  if (!full.startsWith(dir) || !fs.existsSync(full)) return null;
  const ext = path.extname(name).toLowerCase();
  return {
    data: fs.readFileSync(full),
    type: MIME[ext] || 'application/octet-stream',
  };
}
