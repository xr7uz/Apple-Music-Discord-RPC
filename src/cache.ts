import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FORMAT_VERSION = 1;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Default cache location: ~/Library/Caches on macOS, XDG cache dir elsewhere. */
export function defaultCacheFile(name: string): string {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "apple-music-discord-rpc", name);
}

/** Small persistent key/value cache with per-entry expiry, stored as one JSON file. */
export class JsonCache<T> {
  readonly path: string;
  readonly maxEntries: number;
  #entries = new Map<string, Entry<T>>();
  #dirty = false;
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(path: string, maxEntries = 2_000) {
    this.path = path;
    this.maxEntries = maxEntries;
  }

  async load(now = Date.now()): Promise<void> {
    try {
      const file = JSON.parse(await readFile(this.path, "utf8"));
      if (file?.version !== FORMAT_VERSION || typeof file.entries !== "object") return;
      for (const [key, entry] of Object.entries(file.entries as Record<string, Entry<T>>)) {
        if (entry && typeof entry.expiresAt === "number" && entry.expiresAt > now) {
          this.#entries.set(key, entry);
        }
      }
    } catch {
      // missing or corrupt cache, start fresh
    }
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      this.#dirty = true;
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number, now = Date.now()): void {
    // re-insert so Map order stays oldest → newest
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#dirty = true;
    this.#scheduleSave();
  }

  get size(): number {
    return this.#entries.size;
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.flush().catch(() => {});
    }, 2_000);
    this.#saveTimer.unref();
  }

  /** Writes pending changes atomically (temp file + rename). */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    if (!this.#dirty) return;
    this.#dirty = false;
    const body = JSON.stringify({ version: FORMAT_VERSION, entries: Object.fromEntries(this.#entries) });
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, body);
      await rename(tmp, this.path);
    } catch (err) {
      this.#dirty = true;
      throw err;
    }
  }
}
