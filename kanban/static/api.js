// Network helper: 10s timeout, single retry on transport error, top-bar toast
// when a request ultimately fails. The kanban server is local, so everything
// short of "process is gone" should resolve quickly.

const TIMEOUT_MS = 10000;

function showToast(msg) {
  let el = document.getElementById('api-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'api-toast';
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#c0392b;color:#fff;padding:8px 14px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function fetchOnce(path, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      ...opts,
    });
  } finally { clearTimeout(t); }
}

async function api(path, opts = {}) {
  let r, lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { r = await fetchOnce(path, opts); break; }
    catch (e) { lastErr = e; if (attempt === 0) await new Promise(rs => setTimeout(rs, 250)); }
  }
  if (!r) {
    showToast(`network error: ${path} (${lastErr?.message || 'unreachable'})`);
    throw lastErr || new Error('network error');
  }
  let data;
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) {
    const msg = data.error || r.statusText || `HTTP ${r.status}`;
    if (r.status >= 500) showToast(`server error: ${msg}`);
    throw new Error(msg);
  }
  return data;
}

window.api = api;
