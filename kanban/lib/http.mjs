import fs from 'node:fs';
import path from 'node:path';
import { STATIC_DIR } from './config.mjs';

export function sendJson(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

const MAX_BODY = 16 * 1024 * 1024; // 16 MB (covers ~12 MB raw after base64)

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf-8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const CTYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function serveStatic(res, name) {
  // Resolve and prevent path traversal
  const safe = path.normalize(name).replace(/^([/\\])+/, '');
  const full = path.join(STATIC_DIR, safe);
  if (!full.startsWith(STATIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendJson(res, 404, { error: 'not found' });
  const ext = path.extname(full).toLowerCase();
  const ctype = CTYPES[ext] || 'text/plain; charset=utf-8';
  const data = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': ctype,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}
