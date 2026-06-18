// Content script: detects the video on cineby/rivestream, tracks progress into
// CWStore (chrome.storage), shows a resume prompt, and injects an in-page
// "Continue Watching" panel. Shares its isolated world with store.js (loaded first).

(function () {
  'use strict';

  // ===========================================================================
  // Config
  // ===========================================================================
  const SAVE_THROTTLE_MS = 5000;
  const MIN_DURATION_S = 30;
  const MIN_PROGRESS_S = 30;
  const FINISHED_PCT = 95;
  const ROUTE_DEBOUNCE_MS = 300;
  const LOCATION_POLL_MS = 1000;
  const TOAST_AUTOHIDE_MS = 10000;

  const log = (...a) => console.debug('[ContinueWatching]', ...a);
  const nowTs = () => Date.now();

  // ===========================================================================
  // Adapters — per-site extraction (the spot most likely to need a tweak)
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
    const cleaned = t
      .replace(/\s*[-|–]\s*(cineby|rivestream)\b.*$/i, '')
      .replace(/^watch\s+/i, '')
      .replace(/\s+online\b.*$/i, '')
      .trim();
    if (!cleaned || GENERIC_TITLES.test(cleaned)) return null;
    return cleaned;
  }

  function labelFromId(contentId) {
    if (!contentId) return 'Unknown title';
    const [, type, id, season, episode] = contentId.split(':');
    if (type === 'tv' && season != null) return `TV ${id} S${season}·E${episode}`;
    return `${type === 'tv' ? 'TV' : 'Movie'} ${id}`;
  }

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
      matches() {
        return !!parseTmdbPath(prefix);
      },
      extractContentId() {
        const p = parseTmdbPath(prefix);
        return p ? p.id : null;
      },
      extractType() {
        const p = parseTmdbPath(prefix);
        return p ? p.type : 'movie';
      },
      extractTitle() {
        // og:title/document.title are the static shell value ("Cineby") until React
        // hydrates; cleanTitle() rejects the generic value so this stays null until ready.
        return (
          cleanTitle(document.title) ||
          cleanTitle(metaContent('og:title')) ||
          cleanTitle(document.querySelector('h1')?.textContent)
        );
      },
      extractPoster() {
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
    const entry = ADAPTERS.find((e) => e.test(location.hostname));
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

  // ===========================================================================
  // Tracker
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
    let bestTitle = adapter.extractTitle();
    let bestPoster = adapter.extractPoster();
    const refreshMeta = () => {
      const t = adapter.extractTitle();
      if (t) bestTitle = t;
      const p = adapter.extractPoster();
      if (p) bestPoster = p;
    };
    log('tracking', contentId);

    // Resume prompt if we have a saved mid-progress position.
    CWStore.get(contentId).then((saved) => {
      if (signal.aborted || !saved || saved.currentTime <= MIN_PROGRESS_S) return;
      const pct = saved.duration ? (saved.currentTime / saved.duration) * 100 : 0;
      if (pct < FINISHED_PCT) UI.showResume(saved.currentTime, () => seekTo(video, saved.currentTime));
    });

    let lastSave = 0;
    const persist = (force) => {
      const dur = video.duration;
      const cur = video.currentTime;
      if (!isFinite(dur) || dur < MIN_DURATION_S) return;
      const pct = (cur / dur) * 100;
      if (pct >= FINISHED_PCT) {
        CWStore.remove(contentId);
        return;
      }
      if (cur < MIN_PROGRESS_S) return;
      const t = nowTs();
      if (!force && t - lastSave < SAVE_THROTTLE_MS) return;
      lastSave = t;
      refreshMeta();
      CWStore.save({
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
    try {
      video.currentTime = time;
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { log('seek failed', e); }
  }

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
    const timeout = setTimeout(() => obs.disconnect(), 30000);
    if (currentAbort) currentAbort.signal.addEventListener('abort', () => obs.disconnect());
  }

  // ===========================================================================
  // Router
  // ===========================================================================
  // Ask the background worker to pull the latest from sync (no-op if sync is off).
  function requestSync() {
    try { chrome.runtime.sendMessage({ type: 'cw-sync-soon' }); } catch (e) { /* SW asleep */ }
  }

  function onRouteChange() {
    teardownTracker();
    UI.hideResume();
    requestSync();
    const adapter = activeAdapter();
    if (adapter && adapter.matches()) waitForVideoAndTrack(adapter);
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
    setInterval(() => { if (location.href !== lastHref) handle(); }, LOCATION_POLL_MS);
  }

  // ===========================================================================
  // In-page UI (Shadow DOM): floating button, panel, resume toast
  // ===========================================================================
  const UI = (() => {
    let root, fab, panelEl, resumeEl, resumeTimer;

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; width: 52px; height: 52px;
        border-radius: 50%; border: none; cursor: pointer; background: #e50914; color: #fff; font-size: 22px;
        box-shadow: 0 4px 14px rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
      .fab:hover { background: #ff0f1f; }
      .panel { position: fixed; right: 18px; bottom: 80px; z-index: 2147483646; width: 340px; max-height: 70vh;
        background: #15171c; color: #eee; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.6);
        display: none; flex-direction: column; overflow: hidden; }
      .panel.open { display: flex; }
      .panel h3 { margin: 0; padding: 14px 16px; font-size: 15px; border-bottom: 1px solid #2a2d35;
        display: flex; justify-content: space-between; align-items: center; }
      .panel h3 .x { cursor: pointer; color: #888; font-size: 18px; }
      .panel h3 .x:hover { color: #fff; }
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
      .toast { position: fixed; left: 18px; bottom: 18px; z-index: 2147483646; background: #15171c; color: #fff;
        padding: 12px 14px; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.5); display: none;
        align-items: center; gap: 12px; font-size: 13px; }
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

      fab = document.createElement('button');
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

      document.addEventListener('fullscreenchange', () => {
        const fs = !!document.fullscreenElement;
        fab.style.display = fs ? 'none' : 'flex';
        if (fs) panelEl.classList.remove('open');
      });

      // live-refresh the panel when storage changes (e.g. another tab saved progress)
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[CW_KEY] && panelEl.classList.contains('open')) {
          renderPanel();
        }
      });
    }

    async function openPanel() {
      await renderPanel();
      panelEl.classList.add('open');
    }

    function togglePanel() {
      if (panelEl.classList.contains('open')) panelEl.classList.remove('open');
      else openPanel();
    }

    async function renderPanel() {
      const items = await CWStore.list();
      panelEl.innerHTML = '';
      const h = document.createElement('h3');
      const label = document.createElement('span');
      label.textContent = 'Continue Watching';
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.addEventListener('click', () => panelEl.classList.remove('open'));
      h.append(label, x);
      panelEl.appendChild(h);

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
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await CWStore.remove(r.contentId);
        renderPanel();
      });
      row.appendChild(rm);
      return row;
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

    return { build, openPanel, showResume, hideResume };
  })();

  // ===========================================================================
  // Boot
  // ===========================================================================
  async function boot() {
    UI.build();
    installRouter();
    requestSync();
    onRouteChange();

    // Auto-show the panel when you land on the site (but not on a watch page,
    // so it never covers the player), if there's anything to continue.
    const adapter = activeAdapter();
    const onWatchPage = adapter && adapter.matches();
    if (!onWatchPage) {
      const items = await CWStore.list();
      if (items.length) UI.openPanel();
    }
  }

  if (document.body) boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });
})();
