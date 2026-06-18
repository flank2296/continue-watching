// ==UserScript==
// @name         Continue Watching (cineby + rivestream)
// @namespace    video-ext.continue-watching
// @version      0.2.1
// @description  Adds a "Continue Watching" list and resume-from-last-position to cineby & rivestream, with optional end-to-end-encrypted cross-device sync.
// @author       you
// @match        *://*.cineby.at/*
// @match        *://*.cineby.app/*
// @match        *://*.cineby.gd/*
// @match        *://*.rivestream.net/*
// @match        *://*.rivestream.live/*
// @match        *://*.rivestream.org/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      cw-sync.ankushgochke.workers.dev
// @connect      workers.dev
// @homepageURL  https://github.com/flank2296/continue-watching
// @supportURL   https://github.com/flank2296/continue-watching/issues
// @updateURL    https://raw.githubusercontent.com/flank2296/continue-watching/main/continue-watching.user.js
// @downloadURL  https://raw.githubusercontent.com/flank2296/continue-watching/main/continue-watching.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ===========================================================================
  // Config
  // ===========================================================================
  const STORAGE_KEY = 'cw_history_v1';
  const SAVE_THROTTLE_MS = 5000;     // max one write per this interval while playing
  const MIN_DURATION_S = 30;         // ignore tiny clips / ads / pre-load states
  const MIN_PROGRESS_S = 30;         // don't record things barely opened
  const FINISHED_PCT = 95;           // >= this counts as finished -> drop from list
  const MAX_ITEMS = 20;              // cap stored/shown items
  const ROUTE_DEBOUNCE_MS = 300;
  const LOCATION_POLL_MS = 1000;
  const TOAST_AUTOHIDE_MS = 10000;

  const log = (...a) => console.debug('[ContinueWatching]', ...a);

  // ===========================================================================
  // GM API shims (fall back to localStorage if GM_* are unavailable)
  // ===========================================================================
  const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';
  const gmGet = (k, d) => {
    try {
      if (hasGM) return GM_getValue(k, d);
      const raw = localStorage.getItem(k);
      return raw == null ? d : raw;
    } catch (e) { return d; }
  };
  const gmSet = (k, v) => {
    try {
      if (hasGM) GM_setValue(k, v);
      else localStorage.setItem(k, v);
    } catch (e) { log('storage write failed', e); }
  };

  // ===========================================================================
  // Store — single key, map of contentId -> record
  // record: { contentId, type, title, posterUrl, url, currentTime, duration,
  //           progressPct, lastWatched }
  // ===========================================================================
  const Store = {
    _read() {
      const raw = gmGet(STORAGE_KEY, '{}');
      try {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return obj && typeof obj === 'object' ? obj : {};
      } catch (e) { return {}; }
    },
    _write(map) {
      // prune to MAX_ITEMS most-recent before persisting
      const entries = Object.values(map)
        .sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0))
        .slice(0, MAX_ITEMS);
      const pruned = {};
      for (const r of entries) pruned[r.contentId] = r;
      gmSet(STORAGE_KEY, JSON.stringify(pruned));
    },
    get(id) {
      return this._read()[id] || null;
    },
    save(record) {
      const map = this._read();
      map[record.contentId] = record;
      this._write(map);
    },
    remove(id) {
      const map = this._read();
      if (map[id]) {
        delete map[id];
        this._write(map);
      }
    },
    clear() {
      gmSet(STORAGE_KEY, '{}');
    },
    list() {
      return Object.values(this._read())
        .sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0))
        .slice(0, MAX_ITEMS);
    },
    exportJSON() {
      return JSON.stringify(this._read(), null, 2);
    },
    importJSON(str) {
      const incoming = JSON.parse(str);
      if (!incoming || typeof incoming !== 'object') throw new Error('Invalid file');
      const map = this._read();
      let count = 0;
      for (const [id, rec] of Object.entries(incoming)) {
        if (!rec || typeof rec !== 'object' || !rec.contentId) continue;
        const existing = map[id];
        if (!existing || (rec.lastWatched || 0) > (existing.lastWatched || 0)) {
          map[id] = rec;
          count++;
        }
      }
      this._write(map);
      return count;
    },
  };

  // ===========================================================================
  // Sync — optional end-to-end-encrypted sync via a Cloudflare worker.
  // Config { endpoint, passphrase } is stored locally (GM storage) and never sent.
  // The passphrase encrypts the history (AES-GCM) before upload; the server key is
  // a SHA-256 hash of the passphrase, so the server only ever sees ciphertext.
  // Uses GM_xmlhttpRequest to bypass the page's CSP (page fetch may be blocked).
  // ===========================================================================
  const SYNC_CFG_KEY = 'cw_sync_cfg';

  const Sync = (() => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const subtle = (window.crypto && window.crypto.subtle) || null;
    let syncing = false;
    let timer = null;
    let lastStatus = null;

    function getCfg() {
      try {
        const raw = gmGet(SYNC_CFG_KEY, '');
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }
    function setCfg(cfg) { gmSet(SYNC_CFG_KEY, JSON.stringify(cfg)); }
    function enabled() {
      const c = getCfg();
      return !!(c && c.endpoint && c.passphrase);
    }
    function status() { return lastStatus; }

    // GM_xmlhttpRequest promise wrapper (falls back to fetch if unavailable)
    function req(opts) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: opts.method,
            url: opts.url,
            data: opts.data,
            headers: opts.headers || {},
            timeout: 15000,
            onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
            onerror: () => reject(new Error('network error')),
            ontimeout: () => reject(new Error('timeout')),
          });
        } else {
          fetch(opts.url, { method: opts.method, body: opts.data, headers: opts.headers })
            .then(async (r) => resolve({ ok: r.ok, status: r.status, text: await r.text() }))
            .catch(reject);
        }
      });
    }

    // --- crypto ---
    const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
    const ub64 = (str) => { const t = atob(str); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
    async function keyId(pass) {
      const h = await subtle.digest('SHA-256', enc.encode('cw-key-id:' + pass));
      return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    async function aesKey(pass) {
      const bk = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
      return subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode('cw-sync-salt-v1'), iterations: 100000, hash: 'SHA-256' },
        bk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    }
    async function encJSON(pass, obj) {
      const k = await aesKey(pass);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj)));
      return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
    }
    async function decJSON(pass, blob) {
      if (!blob) return {};
      const { iv, ct } = JSON.parse(blob);
      const k = await aesKey(pass);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, k, ub64(ct));
      return JSON.parse(dec.decode(pt));
    }

    function canon(v) {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
      return JSON.stringify(v);
    }
    function mergeMaps(base, inc) {
      const out = { ...base };
      for (const [id, r] of Object.entries(inc)) {
        if (!r || !r.contentId) continue;
        const ex = out[id];
        if (!ex || (r.lastWatched || 0) > (ex.lastWatched || 0)) out[id] = r;
      }
      return out;
    }

    async function run(reason) {
      const cfg = getCfg();
      if (!cfg || !cfg.endpoint || !cfg.passphrase) return { ok: false, error: 'not configured' };
      if (!subtle) return { ok: false, error: 'crypto unavailable (need https)' };
      if (syncing) return { ok: false, error: 'busy' };
      syncing = true;
      try {
        const id = await keyId(cfg.passphrase);
        const url = cfg.endpoint.replace(/\/+$/, '') + '/' + id;

        const get = await req({ method: 'GET', url });
        let remote = {};
        if (get.ok && get.text) {
          try { remote = await decJSON(cfg.passphrase, get.text); }
          catch (e) { throw new Error('decrypt failed (wrong passphrase?)'); }
        } else if (!get.ok && get.status !== 404 && get.status !== 0) {
          throw new Error('server ' + get.status);
        }

        const localMap = Store._read();
        const merged = mergeMaps(remote, localMap);
        const mC = canon(merged);
        if (mC !== canon(localMap)) Store._write(merged);

        let uploaded = false;
        if (mC !== canon(remote)) {
          const body = await encJSON(cfg.passphrase, merged);
          const put = await req({ method: 'PUT', url, data: body, headers: { 'Content-Type': 'text/plain' } });
          if (!put.ok) throw new Error('upload ' + put.status);
          uploaded = true;
        }

        lastStatus = { ok: true, uploaded, ts: nowTs() };
        if (UI.refreshIfOpen) UI.refreshIfOpen();
        return { ok: true, uploaded };
      } catch (e) {
        lastStatus = { ok: false, error: String((e && e.message) || e), ts: nowTs() };
        return { ok: false, error: lastStatus.error };
      } finally {
        syncing = false;
      }
    }

    // debounced trigger so bursts coalesce; reads are cheap, writes only on change
    function schedule(reason, delay = 1500) {
      clearTimeout(timer);
      timer = setTimeout(() => run(reason), delay);
    }

    function start() {
      if (enabled()) run('boot');
      setInterval(() => { if (enabled()) run('interval'); }, 10000);
      window.addEventListener('focus', () => { if (enabled()) schedule('focus', 500); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && enabled()) schedule('visible', 500);
      });
    }

    return { run, schedule, start, getCfg, setCfg, enabled, status };
  })();

  // ===========================================================================
  // Adapters — per-site extraction. THIS is the region most likely to need a
  // one-line tweak after inspecting a live page (see README verification step).
  // ===========================================================================
  function metaContent(prop) {
    const el =
      document.querySelector(`meta[property="${prop}"]`) ||
      document.querySelector(`meta[name="${prop}"]`);
    return el ? el.getAttribute('content') : null;
  }

  const GENERIC_TITLES = /^(cineby|rivestream|loading|home)$/i;

  function cleanTitle(t) {
    if (!t) return null;
    // strip common site suffixes: " - Cineby", " | Rivestream", "Watch ... Online"
    const cleaned = t
      .replace(/\s*[-|–]\s*(cineby|rivestream)\b.*$/i, '')
      .replace(/^watch\s+/i, '')
      .replace(/\s+online\b.*$/i, '')
      .trim();
    // reject the static SPA-shell defaults (these appear before React hydrates the
    // real movie title; og:title is literally "Cineby" on the shell)
    if (!cleaned || GENERIC_TITLES.test(cleaned)) return null;
    return cleaned;
  }

  // Readable fallback when the real title hasn't hydrated yet, e.g. "Movie 758330"
  // or "TV 1399 S1·E1", derived from the contentId.
  function labelFromId(contentId) {
    if (!contentId) return 'Unknown title';
    const parts = contentId.split(':'); // site:type:id[:season:episode]
    const [, type, id, season, episode] = parts;
    if (type === 'tv' && season != null) return `TV ${id} S${season}·E${episode}`;
    return `${type === 'tv' ? 'TV' : 'Movie'} ${id}`;
  }

  // Shared TMDB-SPA path parser. Pathnames look like:
  //   /movie/603            -> movie:603
  //   /tv/1399/1/1          -> tv:1399:1:1
  //   /watch/movie/603 etc. -> tolerant: first movie|tv segment + following digits
  function parseTmdbPath(prefix) {
    const segs = location.pathname.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const kind = segs[i].toLowerCase();
      if ((kind === 'movie' || kind === 'tv') && /^\d+$/.test(segs[i + 1] || '')) {
        const id = segs[i + 1];
        if (kind === 'movie') return { type: 'movie', id: `${prefix}:movie:${id}` };
        const season = /^\d+$/.test(segs[i + 2] || '') ? segs[i + 2] : '1';
        const episode = /^\d+$/.test(segs[i + 3] || '') ? segs[i + 3] : '1';
        return { type: 'tv', id: `${prefix}:tv:${id}:${season}:${episode}` };
      }
    }
    return null;
  }

  function makeTmdbAdapter(prefix) {
    return {
      _parsed: null,
      matches() {
        this._parsed = parseTmdbPath(prefix);
        return !!this._parsed;
      },
      extractContentId() {
        const p = this._parsed || parseTmdbPath(prefix);
        return p ? p.id : null;
      },
      extractType() {
        const p = this._parsed || parseTmdbPath(prefix);
        return p ? p.type : 'movie';
      },
      extractTitle() {
        // Note: on cineby the og:title/document.title start as the static shell value
        // "Cineby" and only become the real title after React hydrates. cleanTitle()
        // rejects the generic value, so this returns null until the real title lands.
        return (
          cleanTitle(document.title) ||
          cleanTitle(metaContent('og:title')) ||
          cleanTitle(document.querySelector('h1')?.textContent)
        );
      },
      extractPoster() {
        // og:image is a generic seo.png on the shell — only trust real TMDB art.
        const tmdb = document.querySelector('img[src*="image.tmdb.org"]');
        if (tmdb) return tmdb.src;
        const og = metaContent('og:image');
        if (og && !/seo\.png(\?|$)/i.test(og)) return og;
        return null;
      },
      getVideo() {
        return document.querySelector('video');
      },
    };
  }

  const ADAPTERS = [
    { test: (h) => /(^|\.)cineby\./i.test(h), adapter: makeTmdbAdapter('cineby') },
    { test: (h) => /(^|\.)rivestream\./i.test(h), adapter: makeTmdbAdapter('rivestream') },
  ];

  function activeAdapter() {
    const host = location.hostname;
    const entry = ADAPTERS.find((e) => e.test(host));
    return entry ? entry.adapter : null;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function relTime(ts) {
    const diff = (nowTs() - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const d = Math.floor(diff / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }

  function nowTs() {
    return Date.now();
  }

  // ===========================================================================
  // Tracker — attach to a <video>, persist progress, manage resume toast.
  // ===========================================================================
  let currentAbort = null;

  function teardownTracker() {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
  }

  function attachTracker(adapter, video) {
    teardownTracker();
    const ac = new AbortController();
    currentAbort = ac;
    const signal = ac.signal;

    const contentId = adapter.extractContentId();
    if (!contentId) return;

    const type = adapter.extractType();
    const url = location.href;
    // Title/poster may not be hydrated yet — re-read them on every save and keep the
    // best value we've seen, so the record upgrades from "Movie 758330" to the real
    // title/art once React fills them in.
    let bestTitle = adapter.extractTitle();
    let bestPoster = adapter.extractPoster();
    const refreshMeta = () => {
      const t = adapter.extractTitle();
      if (t) bestTitle = t;
      const p = adapter.extractPoster();
      if (p) bestPoster = p;
    };
    log('tracking', contentId);

    // Resume toast if we have a saved mid-progress position.
    const saved = Store.get(contentId);
    if (saved && saved.currentTime > MIN_PROGRESS_S) {
      const pct = saved.duration ? (saved.currentTime / saved.duration) * 100 : 0;
      if (pct < FINISHED_PCT) UI.showResume(saved.currentTime, () => seekTo(video, saved.currentTime));
    }

    let lastSave = 0;
    const persist = (force) => {
      const dur = video.duration;
      const cur = video.currentTime;
      if (!isFinite(dur) || dur < MIN_DURATION_S) return;
      const pct = (cur / dur) * 100;
      if (pct >= FINISHED_PCT) {
        Store.remove(contentId);
        if (Sync.enabled()) Sync.schedule('finished', 3000);
        return;
      }
      if (cur < MIN_PROGRESS_S) return;
      const t = nowTs();
      if (!force && t - lastSave < SAVE_THROTTLE_MS) return;
      lastSave = t;
      refreshMeta();
      Store.save({
        contentId,
        type,
        title: bestTitle || labelFromId(contentId),
        posterUrl: bestPoster || '',
        url,
        currentTime: cur,
        duration: dur,
        progressPct: Math.round(pct),
        lastWatched: t,
      });
      if (Sync.enabled()) Sync.schedule('save', 3000);
    };

    video.addEventListener('timeupdate', () => persist(false), { signal });
    video.addEventListener('pause', () => persist(true), { signal });
    document.addEventListener(
      'visibilitychange',
      () => { if (document.visibilityState === 'hidden') persist(true); },
      { signal }
    );
    window.addEventListener('beforeunload', () => persist(true), { signal });
  }

  function seekTo(video, time) {
    const apply = () => { try { video.currentTime = time; } catch (e) { log('seek failed', e); } };
    apply();
    // The player may not be seekable yet (metadata still loading) or may reset to 0
    // right after we set it — retry until the position sticks (~10s max).
    let tries = 0;
    const tick = () => {
      if (tries++ > 20) return;
      if (Math.abs(video.currentTime - time) <= 2) return; // it stuck
      apply();
      setTimeout(tick, 500);
    };
    video.addEventListener('loadedmetadata', apply, { once: true });
    video.addEventListener('canplay', apply, { once: true });
    setTimeout(tick, 300);
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  }

  // Wait for a <video> to appear (React mounts it lazily), then attach.
  function waitForVideoAndTrack(adapter) {
    const existing = adapter.getVideo();
    if (existing) {
      attachTracker(adapter, existing);
      return;
    }
    const obs = new MutationObserver(() => {
      const v = adapter.getVideo();
      if (v) {
        obs.disconnect();
        clearTimeout(timeout);
        attachTracker(adapter, v);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // give up after 30s to avoid leaking the observer
    const timeout = setTimeout(() => obs.disconnect(), 30000);
    // tie observer lifetime to the current route
    if (currentAbort) currentAbort.signal.addEventListener('abort', () => obs.disconnect());
  }

  // ===========================================================================
  // Router — detect SPA navigation, re-resolve adapter + video.
  // ===========================================================================
  function onRouteChange() {
    teardownTracker();
    UI.hideResume();
    if (Sync.enabled()) Sync.schedule('route', 300); // pull latest on navigation
    const adapter = activeAdapter();
    if (adapter && adapter.matches()) {
      waitForVideoAndTrack(adapter);
    }
  }

  function installRouter() {
    const fire = () => window.dispatchEvent(new Event('cw:locationchange'));
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    }
    window.addEventListener('popstate', fire);

    let lastHref = location.href;
    let debounce = null;
    const handle = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (location.href !== lastHref) {
          lastHref = location.href;
          onRouteChange();
        }
      }, ROUTE_DEBOUNCE_MS);
    };
    window.addEventListener('cw:locationchange', handle);
    // poll safety net
    setInterval(() => { if (location.href !== lastHref) handle(); }, LOCATION_POLL_MS);
  }

  // ===========================================================================
  // UI — floating button, panel, resume toast (all in Shadow DOM).
  // ===========================================================================
  const UI = (() => {
    let root, panelEl, resumeEl, resumeTimer;
    let settingsOpen = false;

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .fab {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
        width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
        background: #e50914; color: #fff; font-size: 22px; line-height: 52px;
        box-shadow: 0 4px 14px rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center;
      }
      .fab:hover { background: #ff0f1f; }
      .panel {
        position: fixed; right: 18px; bottom: 80px; z-index: 2147483646;
        width: 340px; max-height: 70vh; background: #15171c; color: #eee;
        border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.6);
        display: none; flex-direction: column; overflow: hidden;
      }
      .panel.open { display: flex; }
      .panel h3 { margin: 0; padding: 14px 16px; font-size: 15px; border-bottom: 1px solid #2a2d35;
        display: flex; justify-content: space-between; align-items: center; }
      .panel h3 .gear { cursor: pointer; color: #9aa0aa; font-size: 15px; background: none; border: none; }
      .panel h3 .gear:hover { color: #fff; }
      .settings { padding: 12px 16px; border-bottom: 1px solid #2a2d35; background: #181b21;
        display: flex; flex-direction: column; gap: 10px; }
      .settings label { font-size: 11px; color: #9aa0aa; display: flex; flex-direction: column; gap: 4px; }
      .settings input { padding: 7px 8px; font-size: 12px; background: #0f1115; border: 1px solid #3a3d45;
        border-radius: 6px; color: #eee; }
      .settings .row2 { display: flex; gap: 6px; }
      .settings .row2 button { flex: 1; padding: 7px 4px; font-size: 11px; border: 1px solid #3a3d45;
        background: #20232b; color: #ddd; border-radius: 6px; cursor: pointer; }
      .settings .row2 button:hover { background: #2a2d35; }
      .sync-status { font-size: 11px; color: #9aa0aa; min-height: 14px; }
      .sync-status.ok { color: #5ad17a; }
      .sync-status.err { color: #ff6b6b; }
      .list { overflow-y: auto; flex: 1; }
      .empty { padding: 24px 16px; color: #888; font-size: 13px; text-align: center; }
      .row { display: flex; gap: 10px; padding: 10px 12px; cursor: pointer; align-items: center; position: relative; }
      .row:hover { background: #1e2129; }
      .row img { width: 46px; height: 68px; object-fit: cover; border-radius: 5px; background: #2a2d35; flex: none; }
      .row .info { flex: 1; min-width: 0; }
      .row .title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row .sub { font-size: 11px; color: #9aa0aa; margin-top: 3px; }
      .bar { height: 4px; background: #34373f; border-radius: 2px; margin-top: 6px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: #e50914; }
      .rm { position: absolute; top: 6px; right: 8px; color: #777; font-size: 14px; display: none; }
      .row:hover .rm { display: block; }
      .rm:hover { color: #fff; }
      .footer { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid #2a2d35; }
      .footer button { flex: 1; padding: 7px 4px; font-size: 11px; border: 1px solid #3a3d45; background: #20232b; color: #ddd; border-radius: 6px; cursor: pointer; }
      .footer button:hover { background: #2a2d35; }
      .toast {
        position: fixed; left: 18px; bottom: 18px; z-index: 2147483646;
        background: #15171c; color: #fff; padding: 12px 14px; border-radius: 10px;
        box-shadow: 0 6px 20px rgba(0,0,0,.5); display: none; align-items: center; gap: 12px; font-size: 13px;
      }
      .toast.open { display: flex; }
      .toast button { border: none; cursor: pointer; border-radius: 6px; padding: 6px 12px; font-size: 13px; }
      .toast .resume { background: #e50914; color: #fff; }
      .toast .dismiss { background: transparent; color: #999; font-size: 16px; padding: 2px 6px; }
    `;

    function build() {
      const host = document.createElement('div');
      host.id = 'cw-root';
      (document.body || document.documentElement).appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);

      const fab = document.createElement('button');
      fab.className = 'fab';
      fab.title = 'Continue Watching';
      fab.textContent = '▶';
      fab.addEventListener('click', togglePanel);
      root.appendChild(fab);

      panelEl = document.createElement('div');
      panelEl.className = 'panel';
      root.appendChild(panelEl);

      resumeEl = document.createElement('div');
      resumeEl.className = 'toast';
      root.appendChild(resumeEl);

      // hide FAB in fullscreen so it never covers player controls
      document.addEventListener('fullscreenchange', () => {
        const fs = !!document.fullscreenElement;
        fab.style.display = fs ? 'none' : 'flex';
        if (fs) panelEl.classList.remove('open');
      });
    }

    function togglePanel() {
      if (panelEl.classList.contains('open')) {
        panelEl.classList.remove('open');
      } else {
        renderPanel();
        panelEl.classList.add('open');
      }
    }

    function renderPanel() {
      const items = Store.list();
      panelEl.innerHTML = '';

      const h = document.createElement('h3');
      const label = document.createElement('span');
      label.textContent = 'Continue Watching';
      const gear = document.createElement('button');
      gear.className = 'gear';
      gear.textContent = '⚙';
      gear.title = 'Sync settings';
      gear.addEventListener('click', () => { settingsOpen = !settingsOpen; renderPanel(); });
      h.append(label, gear);
      panelEl.appendChild(h);

      if (settingsOpen) panelEl.appendChild(renderSettings());

      const list = document.createElement('div');
      list.className = 'list';
      if (!items.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = 'Nothing yet — start a movie and it will show up here.';
        list.appendChild(e);
      } else {
        for (const r of items) list.appendChild(renderRow(r));
      }
      panelEl.appendChild(list);
      panelEl.appendChild(renderFooter());
    }

    function renderSettings() {
      const cfg = Sync.getCfg() || {};
      const box = document.createElement('div');
      box.className = 'settings';

      const mkField = (labelText, type, value, placeholder) => {
        const l = document.createElement('label');
        l.append(document.createTextNode(labelText));
        const input = document.createElement('input');
        input.type = type;
        input.value = value || '';
        input.placeholder = placeholder;
        l.appendChild(input);
        box.appendChild(l);
        return input;
      };
      const endpoint = mkField('Sync server URL', 'url', cfg.endpoint || 'https://cw-sync.ankushgochke.workers.dev', 'https://cw-sync.you.workers.dev');
      const passphrase = mkField('Passphrase', 'password', cfg.passphrase, 'same on every device');

      const row2 = document.createElement('div');
      row2.className = 'row2';
      const save = document.createElement('button');
      save.textContent = 'Save & sync';
      const now = document.createElement('button');
      now.textContent = 'Sync now';
      row2.append(save, now);
      box.appendChild(row2);

      const statusEl = document.createElement('div');
      statusEl.className = 'sync-status';
      box.appendChild(statusEl);
      paintStatus(statusEl);

      const doRun = async () => {
        statusEl.textContent = 'Syncing…';
        statusEl.className = 'sync-status';
        await Sync.run('manual');
        paintStatus(statusEl);
        renderPanel();
      };
      save.addEventListener('click', async () => {
        const ep = endpoint.value.trim();
        if (!ep || !passphrase.value) { alert('Enter both the server URL and a passphrase.'); return; }
        try { new URL(ep); } catch (e) { alert('That URL looks invalid.'); return; }
        Sync.setCfg({ endpoint: ep, passphrase: passphrase.value });
        doRun();
      });
      now.addEventListener('click', doRun);

      return box;
    }

    function paintStatus(el) {
      const s = Sync.status();
      if (!s) { el.textContent = Sync.enabled() ? 'Not synced yet.' : 'Sync is off.'; el.className = 'sync-status'; return; }
      if (s.ok) { el.textContent = `Synced ${relTime(s.ts)}${s.uploaded ? ' (uploaded)' : ''}.`; el.className = 'sync-status ok'; }
      else { el.textContent = `Sync error: ${s.error}`; el.className = 'sync-status err'; }
    }

    function refreshIfOpen() {
      if (panelEl && panelEl.classList.contains('open')) renderPanel();
    }

    function renderRow(r) {
      const row = document.createElement('div');
      row.className = 'row';
      row.addEventListener('click', () => { location.assign(r.url); });

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
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        Store.remove(r.contentId);
        renderPanel();
      });
      row.appendChild(rm);
      return row;
    }

    function renderFooter() {
      const f = document.createElement('div');
      f.className = 'footer';
      const exp = document.createElement('button');
      exp.textContent = 'Export';
      exp.addEventListener('click', doExport);
      const imp = document.createElement('button');
      imp.textContent = 'Import';
      imp.addEventListener('click', doImport);
      const clr = document.createElement('button');
      clr.textContent = 'Clear all';
      clr.addEventListener('click', () => {
        if (confirm('Clear all Continue Watching history on this device?')) {
          Store.clear();
          renderPanel();
        }
      });
      f.append(exp, imp, clr);
      return f;
    }

    function doExport() {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `continue-watching-${stamp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function doImport() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const n = Store.importJSON(String(reader.result));
            alert(`Imported ${n} item(s).`);
            renderPanel();
          } catch (e) {
            alert('Import failed: ' + e.message);
          }
        };
        reader.readAsText(file);
      });
      input.click();
    }

    function showResume(time, onResume) {
      if (!resumeEl) return;
      resumeEl.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = `Resume from ${fmtTime(time)}`;
      const btn = document.createElement('button');
      btn.className = 'resume';
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => { onResume(); hideResume(); });
      const x = document.createElement('button');
      x.className = 'dismiss';
      x.textContent = '✕';
      x.addEventListener('click', hideResume);
      resumeEl.append(span, btn, x);
      resumeEl.classList.add('open');
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(hideResume, TOAST_AUTOHIDE_MS);
    }

    function hideResume() {
      if (resumeEl) resumeEl.classList.remove('open');
      clearTimeout(resumeTimer);
    }

    return { build, showResume, hideResume, refreshIfOpen };
  })();

  // ===========================================================================
  // Boot
  // ===========================================================================
  function boot() {
    UI.build();
    installRouter();
    Sync.start();
    onRouteChange();
  }

  if (document.body) boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });
})();
