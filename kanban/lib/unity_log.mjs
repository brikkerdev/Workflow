// Unity Editor log helpers.
//
// Multiple parallel agents using the same Unity-MCP server end up reading the
// same Editor.log and mis-attributing each other's errors. We address that two
// ways:
//   1. Agents grab a timestamp BEFORE their action, then call
//      readLogSince(ts) afterwards to get only lines newer than that mark.
//   2. The verify_queue's unity_editor lock guarantees no other agent runs
//      Unity-touching work concurrently, so the slice belongs to one agent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Default Editor.log path on each platform. The Unity-using project may
// override via WORKFLOW_UNITY_LOG.
function defaultLogPath() {
  if (process.env.WORKFLOW_UNITY_LOG) return process.env.WORKFLOW_UNITY_LOG;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Unity', 'Editor', 'Editor.log');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'Unity', 'Editor.log');
  }
  return path.join(os.homedir(), '.config', 'unity3d', 'Editor.log');
}

// Snapshot the current end-of-file offset. Use this BEFORE running an action,
// then pass the offset to readLogSince after.
export function logMark(filePath = null) {
  const fp = filePath || defaultLogPath();
  try { return { path: fp, offset: fs.statSync(fp).size, mtime: fs.statSync(fp).mtimeMs }; }
  catch { return { path: fp, offset: 0, mtime: 0 }; }
}

// Read everything appended to the log since the given mark. Returns lines as
// an array. Optional grep regex filters down to relevant lines.
export function readLogSince(mark, opts = {}) {
  if (!mark || !mark.path) return [];
  let stat;
  try { stat = fs.statSync(mark.path); } catch { return []; }
  // If the log was rotated/truncated since the mark, start from 0.
  const start = stat.size < mark.offset ? 0 : mark.offset;
  if (stat.size <= start) return [];
  const fd = fs.openSync(mark.path, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf-8');
    let lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (opts.grep) {
      const re = opts.grep instanceof RegExp ? opts.grep : new RegExp(opts.grep, 'i');
      lines = lines.filter(l => re.test(l));
    }
    if (opts.limit && lines.length > opts.limit) {
      lines = lines.slice(-opts.limit);
    }
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

// Convenience: classify a log slice into errors / warnings / other. Matches
// Unity's typical prefixes plus generic Exception traces.
export function classifyLines(lines) {
  const errors = [];
  const warnings = [];
  const other = [];
  for (const l of lines) {
    if (/^\s*(error|exception|fatal)/i.test(l) || /\bException:|\bError CS\d+/i.test(l)) errors.push(l);
    else if (/^\s*warning/i.test(l) || /\bWarning CS\d+/i.test(l)) warnings.push(l);
    else other.push(l);
  }
  return { errors, warnings, other };
}
