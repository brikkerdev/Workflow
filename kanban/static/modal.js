// Task detail modal — read/edit frontmatter, deps chip picker, attachments grid.

let MODAL_TASK = null;
let MODAL_DEPS = [];          // current deps chips
let MODAL_ATTACHMENTS = [];   // current attachment items

async function openModal(id) {
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
    text: name,
    color: agentColor(name),
  }));
  fillSelect('m-estimate', ['S', 'M', 'L'], t.estimate || 'S');

  // Deps picker
  MODAL_DEPS = [...(t.deps || [])];
  renderDepsChips();
  fillDepsAddSelect();

  setSection('m-goal',       t._goal);
  setSection('m-context',    t._context);
  setSection('m-acceptance', t._acceptance);
  setSection('m-verify',     t._verify);
  setSection('m-notes',      t._notes);

  // Attachments
  MODAL_ATTACHMENTS = [...(t._attachments || [])];
  renderAttachments();

  document.getElementById('m-dispatch').disabled = !(t.status === 'todo' && t.assignee !== 'user');
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
  // sort by id
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

// ---------- Save / close ----------

function closeModal() {
  document.getElementById('modal-bg').classList.remove('open');
  MODAL_TASK = null;
  MODAL_DEPS = [];
  MODAL_ATTACHMENTS = [];
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
  document.getElementById('modal-bg').addEventListener('click', e => {
    if (e.target.id === 'modal-bg') closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('modal-bg').classList.contains('open')) closeModal();
  });

  // Tint assignee select live as it changes
  document.getElementById('m-assignee').addEventListener('change', e => {
    document.getElementById('modal').style.setProperty('--agent', agentColor(e.target.value));
  });

  bindDeps();
  bindAttachmentsDnD();
}

window.openModal = openModal;
window.bindModal = bindModal;
