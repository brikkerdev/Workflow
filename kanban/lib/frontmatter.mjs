const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export function parseTask(text) {
  const m = FM_RE.exec(text);
  if (!m) return [null, text];
  const fmBlock = m[1];
  const body = m[2];
  const fm = {};
  for (const rawLine of fmBlock.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim();
      fm[k] = inner ? inner.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (v.startsWith('"') && v.endsWith('"')) {
      fm[k] = v.slice(1, -1);
    } else {
      fm[k] = v;
    }
  }
  return [fm, body];
}

function fmLine(k, v) {
  if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
  return `${k}: ${v}`;
}

export function serializeTask(fm, body) {
  const order = ['id', 'title', 'iteration', 'assignee', 'status', 'deps', 'estimate'];
  const lines = ['---'];
  const seen = new Set();
  for (const k of order) {
    if (k in fm) { lines.push(fmLine(k, fm[k])); seen.add(k); }
  }
  for (const [k, v] of Object.entries(fm)) {
    if (!seen.has(k) && !k.startsWith('_')) lines.push(fmLine(k, v));
  }
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

export function extractSection(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^##\\s+${escaped}\\s*$`, 'm');
  const m = startRe.exec(body);
  if (!m) return '';
  const start = m.index + m[0].length;
  const tail = body.slice(start);
  const nxt = /^##\s+/m.exec(tail);
  const end = nxt ? start + nxt.index : body.length;
  return body.slice(start, end).trim();
}
