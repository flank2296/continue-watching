// Popup UI: lists Continue Watching items, supports open / remove / export / import / clear.

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function relTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const d = Math.floor(diff / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const listEl = document.getElementById('list');

async function render() {
  const items = await CWStore.list();
  listEl.innerHTML = '';
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing yet — open cineby or rivestream and start watching. Your progress shows up here.';
    listEl.appendChild(e);
    return;
  }
  for (const r of items) listEl.appendChild(renderRow(r));
}

function renderRow(r) {
  const row = document.createElement('div');
  row.className = 'row';
  row.addEventListener('click', () => {
    chrome.tabs.create({ url: r.url });
    window.close();
  });

  const img = document.createElement('img');
  if (r.posterUrl) img.src = r.posterUrl;
  row.appendChild(img);

  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = r.title;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${fmtTime(r.currentTime)} / ${fmtTime(r.duration)} · ${relTime(r.lastWatched)}`;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = `${Math.min(100, r.progressPct || 0)}%`;
  bar.appendChild(fill);
  info.append(title, sub, bar);
  row.appendChild(info);

  const rm = document.createElement('span');
  rm.className = 'rm';
  rm.textContent = '✕';
  rm.title = 'Remove';
  rm.addEventListener('click', async (e) => {
    e.stopPropagation();
    await CWStore.remove(r.contentId);
    render();
  });
  row.appendChild(rm);
  return row;
}

// --- footer actions ---
document.getElementById('export').addEventListener('click', async () => {
  const blob = new Blob([await CWStore.exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `continue-watching-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const fileInput = document.getElementById('file');
document.getElementById('import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const n = await CWStore.importJSON(String(reader.result));
      alert(`Imported ${n} item(s).`);
      render();
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  };
  reader.readAsText(file);
});

document.getElementById('clear').addEventListener('click', async () => {
  if (confirm('Clear all Continue Watching history on this device?')) {
    await CWStore.clear();
    render();
  }
});

// --- sync settings ----------------------------------------------------------
const CFG_KEY = 'cw_sync_cfg';
const STATUS_KEY = 'cw_sync_status';
const syncSection = document.getElementById('sync');
const endpointEl = document.getElementById('endpoint');
const passEl = document.getElementById('passphrase');
const statusEl = document.getElementById('syncStatus');

document.getElementById('gear').addEventListener('click', () => {
  syncSection.hidden = !syncSection.hidden;
});

const DEFAULT_ENDPOINT = 'https://cw-sync.ankushgochke.workers.dev';

async function loadSyncUI() {
  const o = await chrome.storage.local.get([CFG_KEY, STATUS_KEY]);
  const cfg = o[CFG_KEY] || {};
  endpointEl.value = cfg.endpoint || DEFAULT_ENDPOINT; // prefill so you only type the passphrase
  passEl.value = cfg.passphrase || '';
  renderStatus(o[STATUS_KEY]);
}

function renderStatus(s) {
  if (!s) { statusEl.textContent = 'Not synced yet.'; statusEl.className = 'sync-status'; return; }
  if (s.ok) {
    statusEl.textContent = `Synced ${relTime(s.ts)}.`;
    statusEl.className = 'sync-status ok';
  } else {
    statusEl.textContent = `Sync error: ${s.error}`;
    statusEl.className = 'sync-status err';
  }
}

document.getElementById('saveSync').addEventListener('click', async () => {
  const endpoint = endpointEl.value.trim();
  const passphrase = passEl.value;
  if (!endpoint || !passphrase) { alert('Enter both the server URL and a passphrase.'); return; }
  let origin;
  try { origin = new URL(endpoint).origin + '/*'; } catch (e) { alert('That URL looks invalid.'); return; }

  // grant the background worker permission to reach this server
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) { alert('Permission to reach the sync server was denied.'); return; }

  statusEl.textContent = 'Syncing…';
  statusEl.className = 'sync-status';
  const res = await chrome.runtime.sendMessage({ type: 'cw-sync-save-cfg', cfg: { endpoint, passphrase } });
  afterSync(res);
});

document.getElementById('syncNow').addEventListener('click', async () => {
  statusEl.textContent = 'Syncing…';
  statusEl.className = 'sync-status';
  const res = await chrome.runtime.sendMessage({ type: 'cw-sync-now' });
  afterSync(res);
});

async function afterSync(res) {
  const o = await chrome.storage.local.get(STATUS_KEY);
  renderStatus(o[STATUS_KEY]);
  if (res && res.ok) render();
}

loadSyncUI();
render();
