// The game's save: one versioned JSON blob in localStorage, assembled from registered providers. Each part of the
// game registers a key with { get, set } and owns its own data shape; this module only stores and restores them.
//   game.save.register('economy', { get: () => ({ money }), set: (data) => { money = data.money; } });
// Providers registered after the save was loaded receive their data at registration. Storage failures (private
// browsing, full quota) never stop the game.

const SAVE_KEY = 'akl-game-save';
const SAVE_VERSION = 1;

class SaveStore {
  constructor(game, { key = SAVE_KEY, enabled = true } = {}) {
    this.game = game;
    this.key = key;
    this.version = SAVE_VERSION;
    this.enabled = enabled;
    this.providers = new Map();
    this.pending = null; // loaded data waiting for providers not registered yet
    this.loaded = false;
    this.lastSavedAt = 0;
  }

  /** provider: { get(): data, set(data, meta), version? } — get() must return JSON-serialisable data */
  register(key, provider) {
    if (!key || !provider || typeof provider.get !== 'function' || typeof provider.set !== 'function') {
      throw new Error('game.save.register(key, { get, set }) needs both functions');
    }
    this.providers.set(key, provider);
    if (this.pending && Object.hasOwn(this.pending.data, key)) {
      this.apply(key, provider, this.pending.data[key], this.pending.versions?.[key]);
    }
    return () => this.providers.delete(key);
  }

  apply(key, provider, data, version) {
    try {
      provider.set(data, { version: version ?? 1, saveVersion: this.pending?.version ?? this.version });
    } catch (error) {
      console.warn(`[save] "${key}" could not restore its data:`, error);
    }
  }

  read() {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      const blob = JSON.parse(raw);
      if (!blob || typeof blob !== 'object' || !blob.data || typeof blob.data !== 'object') return null;
      if (blob.version > this.version) return null; // written by a newer build: leave it alone
      return blob;
    } catch {
      return null;
    }
  }

  /** Restores every registered provider (called once while the game loads) */
  load() {
    this.loaded = true;
    if (!this.enabled) return false;
    const blob = this.read();
    if (!blob) return false;
    this.pending = blob;
    for (const [key, provider] of this.providers) {
      if (Object.hasOwn(blob.data, key)) this.apply(key, provider, blob.data[key], blob.versions?.[key]);
    }
    this.game.emit('save:loaded', { savedAt: blob.savedAt || 0 });
    return true;
  }

  save() {
    if (!this.enabled) return false;
    const data = {};
    const versions = {};
    for (const [key, provider] of this.providers) {
      try {
        const value = provider.get();
        if (value !== undefined) data[key] = value;
        versions[key] = provider.version ?? 1;
      } catch (error) {
        console.warn(`[save] "${key}" could not provide its data:`, error);
      }
    }
    // keep data of providers that have not registered in this session (a system removed or not loaded yet)
    if (this.pending) for (const key of Object.keys(this.pending.data)) if (!Object.hasOwn(data, key)) data[key] = this.pending.data[key];
    try {
      const savedAt = Date.now();
      localStorage.setItem(this.key, JSON.stringify({ version: this.version, savedAt, versions, data }));
      this.lastSavedAt = savedAt;
      this.game.emit('save:written', { savedAt });
      return true;
    } catch {
      return false;
    }
  }

  clear() {
    this.pending = null;
    try {
      localStorage.removeItem(this.key);
    } catch { /* storage unavailable */ }
  }
}

export { SaveStore, SAVE_KEY, SAVE_VERSION };
