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
  const order = ['id', 'title', 'iteration', 'track', 'assignee', 'status', 'attempts', 'deps', 'estimate'];
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

// Returns { start, end, header } where start..end covers section body.
// If section missing returns null.
export function locateSection(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^(##\\s+${escaped}\\s*)$`, 'm');
  const m = startRe.exec(body);
  if (!m) return null;
  const headerEnd = m.index + m[0].length;
  const tail = body.slice(headerEnd);
  const nxt = /^##\s+/m.exec(tail);
  const end = nxt ? headerEnd + nxt.index : body.length;
  return { headerStart: m.index, headerEnd, end, header: m[0] };
}

export function replaceSection(body, name, newContent) {
  const loc = locateSection(body, name);
  const block = `## ${name}\n${newContent.replace(/\s+$/, '')}\n`;
  if (!loc) {
    const sep = body.endsWith('\n\n') ? '' : (body.endsWith('\n') ? '\n' : '\n\n');
    return body + sep + block;
  }
  const after = body.slice(loc.end);
  const sep = after.startsWith('## ') ? '\n' : '';
  return body.slice(0, loc.headerStart) + block + sep + after;
}

export function appendToSection(body, name, addition) {
  const loc = locateSection(body, name);
  if (!loc) return replaceSection(body, name, addition);
  const before = body.slice(0, loc.end).replace(/\s+$/, '');
  const after = body.slice(loc.end);
  return before + '\n' + addition.replace(/\s+$/, '') + '\n' + (after.startsWith('\n') ? after : (after ? '\n' + after : ''));
}

// Parse markdown checklist items in a section. Returns [{ text, checked, details }].
// Indented (or > -prefixed) lines following a `- [ ]` item are collected into
// `details` until the next checkbox item or blank-line break.
export function parseChecklist(body, sectionName) {
  const sec = extractSection(body, sectionName);
  if (!sec) return [];
  const lines = sec.split('\n');
  const out = [];
  const itemRe = /^(\s*)[-*]\s*\[( |x|X)\]\s*(.+?)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = itemRe.exec(lines[i]);
    if (!m) continue;
    const baseIndent = m[1].length;
    const item = { checked: m[2].toLowerCase() === 'x', text: m[3], details: '' };
    const detailLines = [];
    let j = i + 1;
    while (j < lines.length) {
      const ln = lines[j];
      // stop at next checkbox at any indent level
      if (itemRe.test(ln)) break;
      // blank line is allowed once inside details
      if (ln.trim() === '') {
        // if a non-indented non-list line follows, stop; otherwise keep
        const peek = lines[j + 1] || '';
        if (peek === '' || /^[^\s]/.test(peek) && !itemRe.test(peek)) break;
        detailLines.push('');
        j++; continue;
      }
      // detail must be indented past the checkbox
      const ind = ln.match(/^(\s*)/)[1].length;
      if (ind > baseIndent) {
        detailLines.push(ln.slice(baseIndent + 2)); // strip base indent + "- " width
        j++;
      } else {
        break;
      }
    }
    item.details = detailLines.join('\n').replace(/\s+$/, '');
    out.push(item);
    i = j - 1;
  }
  return out;
}
