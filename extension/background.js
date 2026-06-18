// Background service worker: end-to-end-encrypted sync with the Cloudflare worker.
// Pull -> merge by most-recent -> push. Runs on local changes (debounced), on a
// 5-minute alarm, on startup, and on demand from the popup.
//
// Config (endpoint + passphrase) lives in chrome.storage.local under 'cw_sync_cfg'
// and is NEVER uploaded. The passphrase encrypts the history before it leaves the device.

importScripts('store.js'); // provides CW_KEY and CWStore

const CFG_KEY = 'cw_sync_cfg';
const STATUS_KEY = 'cw_sync_status';

// --- crypto helpers (WebCrypto) ---------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(u8) {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function ub64(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function deriveKeyId(passphrase) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode('cw-key-id:' + passphrase));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveAesKey(passphrase) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('cw-sync-salt-v1'), iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptJSON(passphrase, obj) {
  const key = await deriveAesKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
}

async function decryptJSON(passphrase, blob) {
  if (!blob) return {};
  const { iv, ct } = JSON.parse(blob);
  const key = await deriveAesKey(passphrase);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, key, ub64(ct));
  return JSON.parse(dec.decode(pt));
}

// --- sync engine ------------------------------------------------------------
let syncing = false;

async function getCfg() {
  const o = await chrome.storage.local.get(CFG_KEY);
  return o[CFG_KEY] || null;
}

async function setStatus(s) {
  await chrome.storage.local.set({ [STATUS_KEY]: { ...s, ts: Date.now() } });
}

function mergeMaps(base, incoming) {
  const out = { ...base };
  for (const [id, rec] of Object.entries(incoming)) {
    if (!rec || !rec.contentId) continue;
    const ex = out[id];
    if (!ex || (rec.lastWatched || 0) > (ex.lastWatched || 0)) out[id] = rec;
  }
  return out;
}

// Order-independent canonical form, so we can tell whether anything actually
// changed and skip needless KV writes (the tight free-tier limit is writes/day).
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

async function doSync(reason) {
  const cfg = await getCfg();
  if (!cfg || !cfg.endpoint || !cfg.passphrase) return { ok: false, error: 'not configured' };
  if (syncing) return { ok: false, error: 'busy' };
  syncing = true;
  try {
    const keyId = await deriveKeyId(cfg.passphrase);
    const url = cfg.endpoint.replace(/\/+$/, '') + '/' + keyId;

    // pull
    let remote = {};
    const resp = await fetch(url, { method: 'GET' });
    if (resp.ok) {
      const txt = await resp.text();
      if (txt) {
        try {
          remote = await decryptJSON(cfg.passphrase, txt);
        } catch (e) {
          // wrong passphrase or corrupt blob — don't clobber, surface the error
          throw new Error('decrypt failed (wrong passphrase?)');
        }
      }
    } else if (resp.status !== 404) {
      throw new Error('server ' + resp.status);
    }

    // merge (remote as base, local wins on ties by newer lastWatched)
    const localMap = await CWStore._read();
    const merged = mergeMaps(remote, localMap);
    const mergedC = canon(merged);

    // only touch local storage if the merge produced something new locally
    if (mergedC !== canon(localMap)) await CWStore._write(merged);

    // only upload if the server is missing changes we have (write-optimization:
    // idle polls that find nothing new do a read only, no KV write)
    let uploaded = false;
    if (mergedC !== canon(remote)) {
      const body = await encryptJSON(cfg.passphrase, merged);
      const put = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': 'text/plain' } });
      if (!put.ok) throw new Error('upload ' + put.status);
      uploaded = true;
    }

    await setStatus({ ok: true, reason, uploaded });
    return { ok: true, uploaded };
  } catch (e) {
    const error = String((e && e.message) || e);
    await setStatus({ ok: false, error, reason });
    return { ok: false, error };
  } finally {
    syncing = false;
  }
}

// --- triggers ---------------------------------------------------------------
// Debounced scheduler so bursts (rapid navigation, focus flaps) coalesce into one
// sync. Reads are cheap, so we trigger generously; writes only happen on real change.
let syncTimer = null;
function scheduleSync(reason, delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(reason), delay);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || syncing) return;
  if (changes[CW_KEY]) scheduleSync('local-change', 3000); // push our progress
});

// 1-minute safety-net poll (the practical minimum for chrome.alarms)
function setupAlarm() {
  chrome.alarms.create('cw-sync', { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(() => doSync('startup'));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cw-sync') doSync('alarm');
});
setupAlarm();

// pull fresh whenever a window regains focus (you just came back to this device)
chrome.windows.onFocusChanged.addListener((wid) => {
  if (wid !== chrome.windows.WINDOW_ID_NONE) scheduleSync('focus', 500);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'cw-sync-now') {
    doSync('manual').then(sendResponse);
    return true; // async response
  }
  if (msg.type === 'cw-sync-soon') {
    // fired by the content script when you open/navigate the site — pull latest
    scheduleSync('site-open', 300);
    return; // no response needed
  }
  if (msg.type === 'cw-sync-save-cfg') {
    chrome.storage.local
      .set({ [CFG_KEY]: msg.cfg })
      .then(() => doSync('config'))
      .then(sendResponse);
    return true;
  }
});
