import fs from 'node:fs';
import path from 'node:path';

function resolveRoot() {
  if (process.env.WORKFLOW_PROJECT) return path.resolve(process.env.WORKFLOW_PROJECT);
  return path.resolve(process.cwd());
}

const LOG_BASE = path.join(resolveRoot(), 'logs');

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function ts() {
  return new Date().toISOString();
}

// Per-source, per-day file handle cache.
// Key: "YYYY-MM-DD/source"  Value: absolute file path (dir already created)
const _ready = new Set();
// Days for which rotation has already run this process.
const _rotated = new Set();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AGE_DAYS = 14;

function rotateOldLogs(day) {
  if (_rotated.has(day)) return;
  _rotated.add(day);
  try {
    const todayMs = new Date(day).getTime();
    if (!Number.isFinite(todayMs)) return;
    let entries;
    try { entries = fs.readdirSync(LOG_BASE); } catch { return; }
    for (const name of entries) {
      if (!DATE_RE.test(name)) continue;
      const ms = new Date(name).getTime();
      if (!Number.isFinite(ms)) continue;
      const ageDays = (todayMs - ms) / 86400000;
      if (ageDays > MAX_AGE_DAYS) {
        try { fs.rmSync(path.join(LOG_BASE, name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

function logFile(source) {
  const day = today();
  const key = `${day}/${source}`;
  if (!_ready.has(key)) {
    rotateOldLogs(day);
    const dir = path.join(LOG_BASE, day);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    _ready.add(key);
  }
  return path.join(LOG_BASE, day, `${source}.log`);
}

function write(source, level, tag, msg) {
  const line = `${ts()} ${level} [${tag}] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(logFile(source), line, 'utf-8'); } catch {}
}

// Usage: createLogger('server') or createLogger('workflow')
// Produces logs/YYYY-MM-DD/{source}.log, rolls over at midnight automatically.
export function createLogger(source) {
  return {
    info:  (tag, msg)      => write(source, 'INFO ', tag, msg),
    warn:  (tag, msg)      => write(source, 'WARN ', tag, msg),
    error: (tag, msg, err) => write(source, 'ERROR', tag, err ? `${msg}: ${err.stack || err}` : msg),
  };
}

// Convenience singleton for callers that don't care about source separation.
export const logger = createLogger('server');
