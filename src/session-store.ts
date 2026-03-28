import type { SessionCacheEntry, SessionStore } from "./types.js";

interface InternalEntry {
  value: SessionCacheEntry;
  expiresAt: number;
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, InternalEntry>();

  async get(key: string): Promise<SessionCacheEntry | null> {
    const entry = this.map.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: SessionCacheEntry, ttlMs: number): Promise<void> {
    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
