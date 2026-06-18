// Shared storage layer used by BOTH the content script and the popup.
// Backed by chrome.storage.local (async). One key holds a map of contentId -> record.
//
// record: { contentId, type, title, posterUrl, url, currentTime, duration,
//           progressPct, lastWatched }

const CW_KEY = 'cw_history_v1';
const CW_MAX = 20; // cap stored / shown items

const CWStore = {
  async _read() {
    try {
      const obj = await chrome.storage.local.get(CW_KEY);
      const map = obj[CW_KEY];
      return map && typeof map === 'object' ? map : {};
    } catch (e) {
      return {};
    }
  },

  async _write(map) {
    // keep only the MAX_ITEMS most-recent before persisting
    const entries = Object.values(map)
      .sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0))
      .slice(0, CW_MAX);
    const pruned = {};
    for (const r of entries) pruned[r.contentId] = r;
    await chrome.storage.local.set({ [CW_KEY]: pruned });
  },

  async get(id) {
    return (await this._read())[id] || null;
  },

  async save(record) {
    const map = await this._read();
    map[record.contentId] = record;
    await this._write(map);
  },

  async remove(id) {
    const map = await this._read();
    if (map[id]) {
      delete map[id];
      await this._write(map);
    }
  },

  async clear() {
    await chrome.storage.local.set({ [CW_KEY]: {} });
  },

  async list() {
    return Object.values(await this._read())
      .sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0))
      .slice(0, CW_MAX);
  },

  async exportJSON() {
    return JSON.stringify(await this._read(), null, 2);
  },

  async importJSON(str) {
    const incoming = JSON.parse(str);
    if (!incoming || typeof incoming !== 'object') throw new Error('Invalid file');
    const map = await this._read();
    let count = 0;
    for (const [id, rec] of Object.entries(incoming)) {
      if (!rec || typeof rec !== 'object' || !rec.contentId) continue;
      const existing = map[id];
      if (!existing || (rec.lastWatched || 0) > (existing.lastWatched || 0)) {
        map[id] = rec;
        count++;
      }
    }
    await this._write(map);
    return count;
  },
};

// Expose for the popup and the content script. Content-script files don't reliably
// share top-level `const` bindings across files, so publish these on the global so
// content.js can read CW_KEY (used by its storage-change refresh) and CWStore.
if (typeof window !== 'undefined') {
  window.CWStore = CWStore;
  window.CW_KEY = CW_KEY;
}
