function renderTracks() {
  const view = document.getElementById('view-tracks');
  view.innerHTML = '';
  const tracks = STATE.tracks.tracks || [];
  if (!tracks.length) {
    view.innerHTML = `<div class="empty">no tracks. run <b>/new-track</b> in Claude.</div>`;
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'tracks-view';
  for (const tr of tracks) {
    const sec = document.createElement('div');
    sec.className = 'track-section';
    sec.innerHTML = `
      <div class="track-h">
        <span class="slug">${escapeHtml(tr.slug)}</span>
        <span class="count">${tr.tasks.length} tasks</span>
      </div>`;
    const board = document.createElement('div');
    buildKanbanInto(board, tr.tasks || []);
    sec.appendChild(board);
    wrap.appendChild(sec);
  }
  view.appendChild(wrap);
}

window.renderTracks = renderTracks;
