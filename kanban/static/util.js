function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Toast stack — multiple visible at once, auto-dismiss.
let TOAST_ID = 0;
function toast(msg, kind = 'ok', opts = {}) {
  const stack = document.getElementById('toasts');
  if (!stack) return;
  const id = ++TOAST_ID;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.dataset.id = id;
  el.innerHTML = `<span style="flex:1">${escapeHtml(msg)}</span>${opts.undo ? `<button class="toast-action" data-act="undo">Undo</button>` : ''}`;
  el.addEventListener('click', e => {
    if (e.target.closest('[data-act="undo"]')) {
      if (typeof opts.onUndo === 'function') opts.onUndo();
    }
    el.remove();
  });
  stack.appendChild(el);
  const ttl = kind === 'error' ? 6000 : 3000;
  setTimeout(() => el.remove(), ttl);
}

// Minimal Markdown → HTML.
// Supports: headings (## ###), **bold**, *em*, `code`, links [t](u),
// unordered / ordered lists, [x]/[ ] checkboxes, blockquotes, hr, blank-line paragraphs.
function renderMarkdown(src) {
  if (!src) return '';
  src = String(src).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const inline = (s) => {
    s = escapeHtml(s);
    // code spans
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic (single * not adjacent to space/word edges of bold remnants)
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    // links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    return s;
  };

  while (i < lines.length) {
    const line = lines[i];

    // blank
    if (!line.trim()) { i++; continue; }

    // heading
    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const lvl = Math.min(m[1].length, 6);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i++; continue;
    }

    // hr
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // unordered / checkbox list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const txt = lines[i].replace(/^\s*[-*]\s+/, '');
        const cb = /^\[([ xX])\]\s+(.*)$/.exec(txt);
        if (cb) {
          const checked = cb[1].toLowerCase() === 'x';
          items.push(`<li class="md-task ${checked ? 'done' : ''}"><span class="md-box">${checked ? '✓' : '○'}</span> ${inline(cb[2])}</li>`);
        } else {
          items.push(`<li>${inline(txt)}</li>`);
        }
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // paragraph (consume contiguous non-blank, non-special lines)
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|---+\s*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
      p.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(p.join(' '))}</p>`);
  }

  return out.join('');
}

window.escapeHtml = escapeHtml;
window.renderMarkdown = renderMarkdown;
window.toast = toast;
