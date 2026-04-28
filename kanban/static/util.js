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

// Modal-based confirm. Returns Promise<boolean>.
let CONFIRM_RESOLVE = null;
function confirmModal(opts = {}) {
  const message = typeof opts === 'string' ? opts : (opts.message || '');
  const title = (typeof opts === 'object' && opts.title) || 'Confirm';
  const okText = (typeof opts === 'object' && opts.confirmText) || 'Confirm';
  const cancelText = (typeof opts === 'object' && opts.cancelText) || 'Cancel';
  const danger = !!(typeof opts === 'object' && opts.danger);

  const bg = document.getElementById('confirm-bg');
  if (!bg) return Promise.resolve(false);
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').innerHTML = message;
  const okBtn = document.getElementById('confirm-ok');
  okBtn.textContent = okText;
  okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
  document.getElementById('confirm-cancel').textContent = cancelText;

  return new Promise(resolve => {
    CONFIRM_RESOLVE = resolve;
    bg.classList.add('open');
    setTimeout(() => okBtn.focus(), 50);
  });
}
function closeConfirm(result) {
  const bg = document.getElementById('confirm-bg');
  if (bg) bg.classList.remove('open');
  if (CONFIRM_RESOLVE) { CONFIRM_RESOLVE(result); CONFIRM_RESOLVE = null; }
}
function bindConfirm() {
  document.getElementById('confirm-ok')?.addEventListener('click', () => closeConfirm(true));
  document.getElementById('confirm-cancel')?.addEventListener('click', () => closeConfirm(false));
  document.getElementById('confirm-close')?.addEventListener('click', () => closeConfirm(false));
  document.getElementById('confirm-bg')?.addEventListener('click', e => {
    if (e.target.id === 'confirm-bg') closeConfirm(false);
  });
  document.addEventListener('keydown', e => {
    const bg = document.getElementById('confirm-bg');
    if (!bg?.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
    else if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
  });
}

// Human-readable relative time. Accepts ISO date or YYYY-MM-DD.
function relativeDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const day = Math.round(h / 24);
  if (day < 14) return `${day} day${day === 1 ? '' : 's'} ago`;
  const w = Math.round(day / 7);
  if (w < 8) return `${w} week${w === 1 ? '' : 's'} ago`;
  const mo = Math.round(day / 30);
  if (mo < 18) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(day / 365);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

window.escapeHtml = escapeHtml;
window.renderMarkdown = renderMarkdown;
window.relativeDate = relativeDate;
window.toast = toast;
window.confirmModal = confirmModal;
window.bindConfirm = bindConfirm;
