// Task detail modal — read/edit frontmatter, deps, attachments, verification.

let MODAL_TASK = null;
let MODAL_DEPS = [];
let MODAL_ATTACHMENTS = [];
let MODAL_VERIFY_OPEN = false;
let MODAL_VERIFY_ITEMS = []; // [{ text, pass: true|false|null, note }]

async function openModal(id, opts = {}) {
  try {
    MODAL_TASK = await api(`/api/task/${id}`);
  } catch (e) {
    toast(`load failed: ${e.message}`, 'error');
    return;
  }
  const t = MODAL_TASK;
  const aColor = agentColor(t.assignee);
  document.getElementById('modal').style.setProperty('--agent', aColor);

  document.getElementById('m-id').textContent = t.id;
  document.getElementById('m-title').textContent = t.title || '';

  fillSelect('m-status', STATE.board.valid_statuses || COLS, t.status);
  fillSelect('m-assignee', ['user', ...(STATE.board.agents || [])], t.assignee, name => ({
    text: name, color: agentColor(name),
  }));
  fillSelect('m-estimate', ['S', 'M', 'L'], t.estimate || 'S');

  const attEl = document.getElementById('m-attempts');
  if (attEl) attEl.textContent = `attempts: ${Number(t.attempts || 0)}`;

  MODAL_DEPS = [...(t.deps || [])];
  renderDepsChips();
  fillDepsAddSelect();

  setSection('m-goal',       t._goal);
  setSection('m-context',    t._context);
  setSection('m-acceptance', t._acceptance);
  setSection('m-verify',     t._verify);
  setSection('m-notes',      t._notes);

  renderSubtasks(t._subtasks || []);

  MODAL_ATTACHMENTS = [...(t._attachments || [])];
  renderAttachments();

  document.getElementById('m-dispatch').disabled = !(t.status === 'todo' && t.assignee !== 'user');

  // Verification block
  const canVerify = t.status === 'verifying' || t.status === 'in-progress';
  const verifyBtn = document.getElementById('m-verify-btn');
  verifyBtn.style.display = canVerify ? '' : 'none';
  MODAL_VERIFY_OPEN = false;
  MODAL_VERIFY_ITEMS = (t._criteria || []).map(c => ({ text: c.text, pass: null, note: '' }));
  renderVerifyPanel();
  if (opts.verify && canVerify) toggleVerify(true);

  document.getElementById('modal-bg').classList.add('open');
}

function fillSelect(id, values, current, decorate) {
  const sel = document.getElementById(id);
  sel.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    if (decorate) {
      const d = decorate(v);
      if (d?.color) o.style.color = d.color;
    }
    if (v === current) o.selected = true;
    sel.appendChild(o);
  }
}

function setSection(id, content) {
  const el = document.getElementById(id);
  if (content && content.trim()) {
    el.textContent = content;
    el.classList.remove('empty-c');
  } else {
    el.textContent = '(empty)';
    el.classList.add('empty-c');
  }
}

// ---------- Subtasks ----------

function renderSubtasks(items) {
  const wrap = document.getElementById('m-subtasks');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'content empty-c';
    empty.textContent = '(no subtasks yet — agent fills these)';
    wrap.appendChild(empty);
    return;
  }
  const done = items.filter(s => s.checked).length;
  const head = document.createElement('div');
  head.className = 'sub-head';
  head.innerHTML = `<span>${done}/${items.length}</span><div class="subbar"><i style="width:${Math.round(done * 100 / items.length)}%"></i></div>`;
  wrap.appendChild(head);
  const list = document.createElement('ul');
  list.className = 'sub-list';
  for (const s of items) {
    const li = document.createElement('li');
    li.className = 'sub' + (s.checked ? ' done' : '');
    li.innerHTML = `<span class="sub-box">${s.checked ? '✓' : '○'}</span><span class="sub-text">${escapeHtml(s.text)}</span>`;
    list.appendChild(li);
  }
  wrap.appendChild(list);
}

// ---------- Deps chips ----------

function renderDepsChips() {
  const wrap = document.getElementById('m-deps-chips');
  wrap.innerHTML = '';
  if (!MODAL_DEPS.length) {
    const empty = document.createElement('span');
    empty.className = 'chip-empty';
    empty.textContent = 'no deps';
    wrap.appendChild(empty);
    return;
  }
  for (const d of MODAL_DEPS) {
    const t = STATE.taskIndex[d];
    const met = t && t.status === 'done';
    const chip = document.createElement('span');
    chip.className = 'chip dep' + (met ? ' met' : ' unmet');
    chip.innerHTML = `
      <span class="chip-id">${escapeHtml(d)}</span>
      ${t ? `<span class="chip-title">${escapeHtml(t.title || '')}</span>` : ''}
      <button class="chip-x" title="remove" aria-label="remove">×</button>
    `;
    chip.querySelector('.chip-x').addEventListener('click', () => {
      MODAL_DEPS = MODAL_DEPS.filter(x => x !== d);
      renderDepsChips();
      fillDepsAddSelect();
    });
    wrap.appendChild(chip);
  }
}

function fillDepsAddSelect() {
  const sel = document.getElementById('m-deps-add');
  sel.innerHTML = '<option value="">+ add dep…</option>';
  const seen = new Set([MODAL_TASK?.id, ...MODAL_DEPS]);
  const all = allTasks().filter(t => !seen.has(t.id));
  all.sort((a, b) => a.id.localeCompare(b.id));
  for (const t of all) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${t.id} — ${t.title || ''}`.slice(0, 80);
    sel.appendChild(o);
  }
}

function bindDeps() {
  const sel = document.getElementById('m-deps-add');
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (!v) return;
    if (!MODAL_DEPS.includes(v)) MODAL_DEPS.push(v);
    sel.value = '';
    renderDepsChips();
    fillDepsAddSelect();
  });
}

// ---------- Attachments ----------

function renderAttachments() {
  const grid = document.getElementById('m-attachments');
  grid.innerHTML = '';
  for (const a of MODAL_ATTACHMENTS) {
    const item = document.createElement('div');
    item.className = 'att';
    item.innerHTML = `
      <a class="att-thumb" href="${a.url}" target="_blank" rel="noopener">
        <img src="${a.url}" alt="${escapeHtml(a.name)}">
      </a>
      <div class="att-foot">
        <span class="att-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <button class="att-x" title="delete">×</button>
      </div>
    `;
    item.querySelector('.att-x').addEventListener('click', async () => {
      if (!confirm(`Delete ${a.name}?`)) return;
      try {
        await api(`/api/task/${MODAL_TASK.id}/attachments/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
        MODAL_ATTACHMENTS = MODAL_ATTACHMENTS.filter(x => x.name !== a.name);
        renderAttachments();
        toast(`${a.name} deleted`);
      } catch (e) {
        toast(`delete failed: ${e.message}`, 'error');
      }
    });
    grid.appendChild(item);
  }
  const add = document.createElement('label');
  add.className = 'att att-add';
  add.innerHTML = `
    <input type="file" accept="image/*" multiple style="display:none" id="m-att-input">
    <span class="att-add-icon">+</span>
    <span class="att-add-label">Add image</span>
  `;
  grid.appendChild(add);
  add.querySelector('input').addEventListener('change', e => uploadFiles(e.target.files));
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
      toast(`uploaded ${item.name}`);
    } catch (e) {
      toast(`upload failed: ${e.message}`, 'error');
    }
  };
  reader.readAsDataURL(file);
}

function bindAttachmentsDnD() {
  const dz = document.getElementById('m-attachments');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drop'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drop'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drop');
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });
}

// ---------- Verification panel ----------

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
    ${items.length ? itemsHtml : '<div class="content empty-c">no acceptance criteria — add some to the task body</div>'}
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
    if (r.result === 'done') toast(`${MODAL_TASK.id} ✓ done · commit ${r.commit?.slice(0, 7) || ''}`);
    else if (r.result === 'rework') toast(`${MODAL_TASK.id} → rework (attempt ${r.attempts})`);
    else toast(`${MODAL_TASK.id} ${r.result}`);
    closeModal();
    await refresh();
  } catch (e) {
    toast(`verify failed: ${e.message}`, 'error');
  }
}

// ---------- Save / close ----------

function closeModal() {
  document.getElementById('modal-bg').classList.remove('open');
  MODAL_TASK = null;
  MODAL_DEPS = [];
  MODAL_ATTACHMENTS = [];
  MODAL_VERIFY_OPEN = false;
  MODAL_VERIFY_ITEMS = [];
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
    toast(`${MODAL_TASK.id} saved`);
    closeModal();
    await refresh();
  } catch (e) {
    toast(`save failed: ${e.message}`, 'error');
  }
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
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('modal-bg').classList.contains('open')) closeModal();
  });

  document.getElementById('m-assignee').addEventListener('change', e => {
    document.getElementById('modal').style.setProperty('--agent', agentColor(e.target.value));
  });

  bindDeps();
  bindAttachmentsDnD();
}

window.openModal = openModal;
window.bindModal = bindModal;
