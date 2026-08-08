// localStorage-backed settings + level progress. Degrades to memory if storage
// is unavailable (private mode, file://).

const NS = 'lga:';
const memory = new Map();

let backing;
try {
  const probe = NS + 'probe';
  window.localStorage.setItem(probe, '1');
  window.localStorage.removeItem(probe);
  backing = window.localStorage;
} catch {
  backing = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, v),
    removeItem: (k) => memory.delete(k),
  };
}

export const store = {
  get(key, fallback = null) {
    const raw = backing.getItem(NS + key);
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  set(key, value) {
    try {
      backing.setItem(NS + key, JSON.stringify(value));
      store.writable = true;
    } catch {
      // Storage full or blocked. Degrade to memory rather than logging on every
      // keystroke - the UI surfaces this once via store.writable.
      store.writable = false;
      memory.set(NS + key, JSON.stringify(value));
    }
    return value;
  },

  /** False once a write has failed, so the UI can say so exactly once. */
  writable: true,

  remove(key) {
    backing.removeItem(NS + key);
  },

  getProgress() {
    return store.get('progress', {});
  },

  setSolved(levelId, commandCount = 0) {
    const progress = store.getProgress();
    const previous = progress[levelId] || {};
    const best =
      typeof previous.bestCommands === 'number'
        ? Math.min(previous.bestCommands, commandCount)
        : commandCount;
    progress[levelId] = { solved: true, bestCommands: best };
    return store.set('progress', progress);
  },

  resetProgress() {
    return store.set('progress', {});
  },
};
