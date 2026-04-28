// Workflow — Task detail modal (design markup: task-modal-grid, dep-picker, attachments).

let MODAL_TASK = null;
let MODAL_DEPS = [];
let MODAL_ATTACHMENTS = [];
let MODAL_VERIFY_OPEN = false;
let MODAL_VERIFY_ITEMS = [];
let MODAL_DELETE_CONFIRM = false;

async function openModal(id, opts = {}) {
  try {
    MODAL_TASK = await api(`/api/task/${id}`);
  } catch (e) {
    toast(`load failed: ${e.message}`, 'error');
    return;
  }
  const t = MODAL_TASK;

  // header
  const dot = document.getElementById('m-dot');
  if (dot) {
    dot.className = `dot s-${t.status || 'todo'}`;
    if (t.status === 'in-progress') dot.classList.add('pulse');
  }
  document.getElementById('m-id').textContent = t.id;
  document.getElementById('m-title').textContent = t.title || '';

  // attempts badge
  const attEl = document.getElementById('m-attempts');
  const attempts = Number(t.attempts || 0);
  if (attEl) {
    attEl.textContent = attempts > 0 ? `attempts: ${attempts}` : '';
    attEl.style.display = attempts > 0 ? '' : 'none';
  }

  // selects
  fillSelect('m-status', STATE.board.valid_statuses || ALL_STATUSES, t.status);
  fillSelect('m-assignee', ['user', ...(STATE.board.agents || [])], t.assignee);
  fillSelect('m-estimate', ['S', 'M', 'L'], t.estimate || 'S');

  // deps
  MODAL_DEPS = [...(t.deps || [])];
  renderDepsChips();
  document.getElementById('m-deps-input').value = '';
  document.getElementById('m-deps-suggest').style.display = 'none';

  // editable markdown sections
  bindSection('m-goal',       'Goal',                t._goal);
  bindSection('m-context',    'Context',             t._context);
  bindSection('m-acceptance', 'Acceptance criteria', t._acceptance);
  bindSection('m-verify',     'How to verify',       t._verify);
  bindSection('m-notes',      'Notes',               t._notes);
  renderSubtasks(t._subtasks || []);

  // attachments
  MODAL_ATTACHMENTS = [...(t._attachments || [])];
  renderAttachments();

  // dispatch button enabled state — disabled for non-todo, user-assigned, or verifying
  const dispatchBtn = document.getElementById('m-dispatch');
  if (dispatchBtn) dispatchBtn.disabled = !(t.status === 'todo' && t.assignee !== 'user');

  // Verify panel: auto-open when verifying. Manual toggle button hidden — panel
  // sits at the top of modal-body before any task info.
  const verifyBtn = document.getElementById('m-verify-btn');
  if (verifyBtn) verifyBtn.style.display = 'none';
  MODAL_VERIFY_OPEN = t.status === 'verifying' || !!opts.verify;
  MODAL_VERIFY_ITEMS = (t._criteria || []).map(c => ({ text: c.text, pass: null, note: '' }));
  renderVerifyPanel();

  // reset delete confirm
  MODAL_DELETE_CONFIRM = false;
  renderFooter();

  document.getElementById('modal-bg').classList.add('open');
}

function fillSelect(id, values, current) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  }
}

// ─── Editable markdown sections ─────────────────────────────────────────────

const SECTION_HEADINGS = {
  'm-goal':       'Goal',
  'm-context':    'Context',
  'm-acceptance': 'Acceptance criteria',
  'm-verify':     'How to verify',
  'm-notes':      'Notes',
};

function renderSectionView(el, content) {
  el.classList.remove('editing');
  if (content && content.trim()) {
    el.innerHTML = renderMarkdown(content);
    el.classList.remove('empty');
    el.title = 'click to edit';
  } else {
    el.textContent = '(click to add)';
    el.classList.add('empty');
    el.title = 'click to edit';
  }
}

function bindSection(id, heading, content) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.heading = heading;
  renderSectionView(el, content || '');
  el.onclick = () => beginSectionEdit(id);
}

function beginSectionEdit(id) {
  const el = document.getElementById(id);
  if (!el || el.classList.contains('editing')) return;
  el.classList.add('editing');
  el.classList.remove('empty');
  const current = MODAL_TASK?.['_' + id.replace('m-', '')] || '';

  el.innerHTML = `
    <textarea class="task-md-edit" rows="6">${escapeHtml(current)}</textarea>
    <div class="task-md-actions">
      <button class="btn btn-ghost" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>
  `;
  el.onclick = null;
  const ta = el.querySelector('textarea');
  ta.focus();
  // auto-resize
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 4, 600) + 'px'; };
  grow();
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); cancelSectionEdit(id); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commitSectionEdit(id); }
  });
  el.querySelector('[data-act="cancel"]').addEventListener('click', e => { e.stopPropagation(); cancelSectionEdit(id); });
  el.querySelector('[data-act="save"]').addEventListener('click', e => { e.stopPropagation(); commitSectionEdit(id); });
}

function cancelSectionEdit(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const key = '_' + id.replace('m-', '');
  renderSectionView(el, MODAL_TASK?.[key] || '');
  el.onclick = () => beginSectionEdit(id);
}

async function commitSectionEdit(id) {
  if (!MODAL_TASK) return;
  const el = document.getElementById(id);
  const ta = el.querySelector('textarea');
  if (!ta) return;
  const newContent = ta.value;
  const heading = SECTION_HEADINGS[id];
  const newBody = replaceSection(MODAL_TASK._body || '', heading, newContent);
  try {
    const updated = await api(`/api/task/${MODAL_TASK.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: newBody }),
    });
    // refetch full task to get re-parsed sections
    MODAL_TASK = await api(`/api/task/${MODAL_TASK.id}`);
    const key = '_' + id.replace('m-', '');
    renderSectionView(el, MODAL_TASK[key] || '');
    el.onclick = () => beginSectionEdit(id);
    toast(`${MODAL_TASK.id} updated`, 'success');
    refresh();
  } catch (e) { toast(`save failed: ${e.message}`, 'error'); }
}

// Replace the body of a `## Heading` section with new content. If the section
// doesn't exist, append it at end.
function replaceSection(body, heading, newContent) {
  const re = new RegExp(`(^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`, 'm');
  const trimmed = newContent.replace(/\s+$/, '');
  if (re.test(body)) {
    return body.replace(re, (_, h) => `${h}${trimmed ? trimmed + '\n' : ''}`);
  }
  // append
  const sep = body.endsWith('\n') ? '' : '\n';
  return body + sep + `\n## ${heading}\n${trimmed ? trimmed + '\n' : ''}`;
}

// ─── Subtasks ───────────────────────────────────────────────────────────────

function renderSubtasks(items) {
  const wrap = document.getElementById('m-subtasks');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!items.length) {
    wrap.innerHTML = `<div class="task-md empty">(no subtasks yet — agent fills these)</div>`;
    return;
  }
  const done = items.filter(s => s.checked).length;
  const head = document.createElement('div');
  head.className = 'subprog';
  head.innerHTML = `<span class="subtxt">${done}/${items.length}</span><div class="subbar"><i style="width:${Math.round(done*100/items.length)}%"></i></div>`;
  wrap.appendChild(head);
  for (const s of items) {
    const row = document.createElement('div');
    row.className = 'history-row';
    row.style.borderBottom = 'none';
    row.innerHTML = `
      <span style="color:${s.checked ? 'var(--dot-done)' : 'var(--fg-2)'}">${s.checked ? '✓' : '○'}</span>
      <span style="color:${s.checked ? 'var(--fg-2)' : 'var(--fg-1)'};text-decoration:${s.checked ? 'line-through' : 'none'}">${escapeHtml(s.text)}</span>
      <span></span>
    `;
    wrap.appendChild(row);
  }
}

// ─── Deps picker (autocomplete) ─────────────────────────────────────────────

function renderDepsChips() {
  const wrap = document.getElementById('m-deps-chips');
  // remove all chips inside the picker, but keep the input
  const picker = document.getElementById('m-deps-picker');
  picker.querySelectorAll('.chip').forEach(c => c.remove());
  const input = document.getElementById('m-deps-input');
  for (const d of MODAL_DEPS) {
    const t = STATE.taskIndex[d];
    const ready = t && t.status === 'done';
    const chip = document.createElement('span');
    chip.className = `chip chip-removable ${ready ? 'chip-dep-ready' : 'chip-dep-wait'}`;
    chip.innerHTML = `${ready ? '✓' : '·'} ${escapeHtml(d)}<span class="x" title="remove">×</span>`;
    chip.querySelector('.x').addEventListener('click', () => {
      MODAL_DEPS = MODAL_DEPS.filter(x => x !== d);
      renderDepsChips();
    });
    picker.insertBefore(chip, input);
  }
}

function bindDeps() {
  const input = document.getElementById('m-deps-input');
  const sug = document.getElementById('m-deps-suggest');
  input.addEventListener('input', () => updateDepSuggest());
  input.addEventListener('focus', () => updateDepSuggest());
  input.addEventListener('blur', () => setTimeout(() => sug.style.display = 'none', 150));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = sug.querySelector('.row');
      if (first) first.click();
    } else if (e.key === 'Backspace' && !input.value && MODAL_DEPS.length) {
      MODAL_DEPS.pop();
      renderDepsChips();
    }
  });
}

function updateDepSuggest() {
  const input = document.getElementById('m-deps-input');
  const sug = document.getElementById('m-deps-suggest');
  const q = (input.value || '').trim().toLowerCase();
  const seen = new Set([MODAL_TASK?.id, ...MODAL_DEPS]);
  const candidates = allTasks().filter(t => !seen.has(t.id) && (!q || t.id.toLowerCase().includes(q) || (t.title || '').toLowerCase().includes(q)));
  if (!candidates.length) { sug.style.display = 'none'; return; }
  sug.innerHTML = '';
  for (const t of candidates.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="id">${escapeHtml(t.id)}</span><span class="ti">${escapeHtml((t.title || '').slice(0, 50))}</span>`;
    row.addEventListener('click', () => {
      if (!MODAL_DEPS.includes(t.id)) MODAL_DEPS.push(t.id);
      input.value = '';
      sug.style.display = 'none';
      renderDepsChips();
      input.focus();
    });
    sug.appendChild(row);
  }
  sug.style.display = '';
}

// ─── Attachments ────────────────────────────────────────────────────────────

function renderAttachments() {
  const grid = document.getElementById('m-attachments');
  grid.innerHTML = '';
  for (const a of MODAL_ATTACHMENTS) {
    const item = document.createElement('div');
    item.className = 'attachment';
    item.innerHTML = `
      <a href="${a.url}" target="_blank" rel="noopener" style="display:block;width:100%;height:100%">
        <img src="${a.url}" alt="${escapeHtml(a.name)}" loading="lazy">
      </a>
      <button class="attachment-x" title="delete">×</button>
    `;
    item.querySelector('.attachment-x').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Delete ${a.name}?`)) return;
      try {
        await api(`/api/task/${MODAL_TASK.id}/attachments/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
        MODAL_ATTACHMENTS = MODAL_ATTACHMENTS.filter(x => x.name !== a.name);
        renderAttachments();
        toast(`${a.name} deleted`, 'success');
      } catch (e2) { toast(`delete failed: ${e2.message}`, 'error'); }
    });
    grid.appendChild(item);
  }
  const add = document.createElement('label');
  add.className = 'attachment-add';
  add.innerHTML = `
    <input type="file" accept="image/*" multiple style="display:none">
    <span class="attachment-add-icon">+</span>
    <span class="attachment-add-label">Add image</span>
  `;
  add.querySelector('input').addEventListener('change', e => uploadFiles(e.target.files));
  grid.appendChild(add);
}

function uploadFiles(files) {
  if (!files || !files.length) return;
  for (const f of files) uploadOne(f);
}

async function uploadOne(file) {
  if (!file.type.startsWith('image/')) {
    toast(`skipped ${file.name}: not an image`, 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    const b64 = String(reader.result).split(',')[1] || '';
    try {
      const item = await api(`/api/task/${MODAL_TASK.id}/attachments`, {
        method: 'POST',
        body: JSON.stringify({ name: file.name, dataBase64: b64 }),
      });
      MODAL_ATTACHMENTS.push(item);
      renderAttachments();
      toast(`uploaded ${item.name}`, 'success');
    } catch (e) { toast(`upload failed: ${e.message}`, 'error'); }
  };
  reader.readAsDataURL(file);
}

function bindAttachmentsDnD() {
  const dz = document.getElementById('m-attachments');
  if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drop'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drop'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drop');
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });
}

// ─── Verification panel ─────────────────────────────────────────────────────

function toggleVerify(on) {
  MODAL_VERIFY_OPEN = on != null ? !!on : !MODAL_VERIFY_OPEN;
  renderVerifyPanel();
}

function renderVerifyPanel() {
  const panel = document.getElementById('m-verify-panel');
  if (!panel) return;
  panel.classList.toggle('open', MODAL_VERIFY_OPEN);
  if (!MODAL_VERIFY_OPEN) { panel.innerHTML = ''; return; }

  const items = MODAL_VERIFY_ITEMS;
  const itemsHtml = items.map((it, i) => `
    <div class="vrow ${it.pass === true ? 'ok' : it.pass === false ? 'fail' : ''}">
      <div class="vrow-h">
        <span class="vtxt">${escapeHtml(it.text)}</span>
        <span class="vbtns">
          <button data-vi="${i}" data-vp="1" class="vp ${it.pass === true ? 'sel' : ''}">✓</button>
          <button data-vi="${i}" data-vp="0" class="vf ${it.pass === false ? 'sel' : ''}">✗</button>
        </span>
      </div>
      <textarea class="vnote" data-vn="${i}" placeholder="что не так / комментарий" ${it.pass !== false ? 'style="display:none"' : ''}>${escapeHtml(it.note || '')}</textarea>
    </div>
  `).join('');

  const anyFail = items.some(i => i.pass === false);
  const allPass = items.length > 0 && items.every(i => i.pass === true);

  panel.innerHTML = `
    <div class="vhead">Verification checklist (attempt ${(MODAL_TASK.attempts || 0) + (anyFail ? 1 : 0)})</div>
    ${items.length ? itemsHtml : '<div class="task-md empty">no acceptance criteria — add some to the task body</div>'}
    <div class="vrow vrow-summary">
      <textarea id="vsummary" class="vnote" placeholder="общий summary (опционально, попадёт в коммит при approve)"></textarea>
    </div>
    <div class="vactions">
      <button class="vapprove" ${allPass ? '' : 'disabled'}>Approve · commit + push + done</button>
      <button class="vreject" ${anyFail ? '' : 'disabled'}>Reject · re-queue agent (attempt+1)</button>
    </div>
  `;

  panel.querySelectorAll('button[data-vi]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.vi);
      const v = btn.dataset.vp === '1';
      MODAL_VERIFY_ITEMS[i].pass = v;
      renderVerifyPanel();
    });
  });
  panel.querySelectorAll('textarea[data-vn]').forEach(ta => {
    ta.addEventListener('input', () => {
      MODAL_VERIFY_ITEMS[Number(ta.dataset.vn)].note = ta.value;
    });
  });
  panel.querySelector('.vapprove')?.addEventListener('click', () => submitVerify('approve'));
  panel.querySelector('.vreject')?.addEventListener('click', () => submitVerify('reject'));
}

async function submitVerify(decision) {
  if (!MODAL_TASK) return;
  const summary = (document.getElementById('vsummary')?.value || '').trim();
  const items = MODAL_VERIFY_ITEMS.map(it => ({ text: it.text, pass: it.pass === true, note: it.note || '' }));
  try {
    const r = await api(`/api/task/${MODAL_TASK.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ decision, summary, items }),
    });
    if (r.result === 'done') toast(`${MODAL_TASK.id} ✓ done · commit ${r.commit?.slice(0, 7) || ''}`, 'success');
    else if (r.result === 'rework') toast(`${MODAL_TASK.id} → rework (attempt ${r.attempts})`, 'warn');
    else toast(`${MODAL_TASK.id} ${r.result}`);
    closeModal();
    await refresh();
  } catch (e) { toast(`verify failed: ${e.message}`, 'error'); }
}

// ─── Footer (delete confirm) ────────────────────────────────────────────────

function renderFooter() {
  const dz = document.getElementById('m-danger-zone');
  if (!dz) return;
  if (MODAL_DELETE_CONFIRM) {
    dz.innerHTML = `
      <div class="modal-foot-confirm">
        <span>Delete ${escapeHtml(MODAL_TASK?.id || '')}? Cannot be undone.</span>
        <button class="btn btn-ghost" id="m-delete-cancel">Cancel</button>
        <button class="btn btn-danger" id="m-delete-confirm">Confirm delete</button>
      </div>
    `;
    document.getElementById('m-delete-cancel').addEventListener('click', () => {
      MODAL_DELETE_CONFIRM = false;
      renderFooter();
    });
    document.getElementById('m-delete-confirm').addEventListener('click', deleteTask);
  } else {
    dz.innerHTML = `<button class="btn btn-danger" id="m-delete">Delete</button>`;
    document.getElementById('m-delete').addEventListener('click', () => {
      MODAL_DELETE_CONFIRM = true;
      renderFooter();
    });
  }
}

async function deleteTask() {
  if (!MODAL_TASK) return;
  try {
    await api(`/api/task/${MODAL_TASK.id}`, { method: 'DELETE' });
    toast(`${MODAL_TASK.id} deleted`, 'success');
    closeModal();
    await refresh();
  } catch (e) { toast(`delete failed: ${e.message}`, 'error'); }
}

// ─── Save / close ──────────────────────────────────────────────────────────

function closeModal() {
  document.getElementById('modal-bg').classList.remove('open');
  MODAL_TASK = null;
  MODAL_DEPS = [];
  MODAL_ATTACHMENTS = [];
  MODAL_VERIFY_OPEN = false;
  MODAL_VERIFY_ITEMS = [];
  MODAL_DELETE_CONFIRM = false;
}

async function saveModal() {
  if (!MODAL_TASK) return;
  const patch = {
    status:   document.getElementById('m-status').value,
    assignee: document.getElementById('m-assignee').value,
    estimate: document.getElementById('m-estimate').value,
    deps:     [...MODAL_DEPS],
  };
  try {
    await api(`/api/task/${MODAL_TASK.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    toast(`${MODAL_TASK.id} saved`, 'success');
    closeModal();
    await refresh();
  } catch (e) { toast(`save failed: ${e.message}`, 'error'); }
}

function bindModal() {
  document.getElementById('m-close').addEventListener('click', closeModal);
  document.getElementById('m-cancel').addEventListener('click', closeModal);
  document.getElementById('m-save').addEventListener('click', saveModal);
  document.getElementById('m-dispatch').addEventListener('click', async () => {
    if (!MODAL_TASK) return;
    await dispatchTask(MODAL_TASK.id);
    closeModal();
  });
  document.getElementById('m-verify-btn').addEventListener('click', () => toggleVerify());
  document.getElementById('modal-bg').addEventListener('click', e => {
    if (e.target.id === 'modal-bg') closeModal();
  });
  bindDeps();
  bindAttachmentsDnD();
}

window.openModal = openModal;
window.closeModal = closeModal;
window.bindModal = bindModal;
