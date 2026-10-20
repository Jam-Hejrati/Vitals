import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Key-value cache for fetched data. Values may be `null` to remember "not found";
 * `undefined` means a miss.
 */
export interface Cache {
  get<T>(namespace: string, key: string): Promise<T | null | undefined>;
  set<T>(namespace: string, key: string, value: T | null): Promise<void>;
}

interface Entry {
  storedAt: number;
  value: unknown;
}

/** One JSON file per entry under `dir/<namespace>/`, expiring after `ttlMs`. */
export class FileCache implements Cache {
  private readonly created = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(namespace: string, key: string): Promise<T | null | undefined> {
    let entry: Entry;
    try {
      entry = JSON.parse(await readFile(this.path(namespace, key), 'utf8'));
    } catch {
      return undefined;
    }
    if (this.now() - entry.storedAt > this.ttlMs) return undefined;
    return entry.value as T | null;
  }

  async set<T>(namespace: string, key: string, value: T | null): Promise<void> {
    const dir = join(this.dir, namespace);
    if (!this.created.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.created.add(dir);
    }
    // Write then rename, so a concurrent run never reads a half-written file.
    const path = this.path(namespace, key);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ storedAt: this.now(), value } satisfies Entry));
    await rename(temporary, path);
  }

  private path(namespace: string, key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return join(this.dir, namespace, `${hash}.json`);
  }
}

export class MemoryCache implements Cache {
  private readonly entries = new Map<string, unknown>();

  async get<T>(namespace: string, key: string): Promise<T | null | undefined> {
    return this.entries.get(`${namespace}\0${key}`) as T | null | undefined;
  }

  async set<T>(namespace: string, key: string, value: T | null): Promise<void> {
    this.entries.set(`${namespace}\0${key}`, value);
  }
}

/** `VITALS_CACHE_DIR`, or the platform's per-user cache directory. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VITALS_CACHE_DIR) return env.VITALS_CACHE_DIR;
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'vitals', 'cache');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'vitals');
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'vitals');
}

/**
 * Looks every key up in the cache, fetches the misses in one go, and caches what was fetched.
 * Keys the fetcher does not return are cached as not found.
 */
export async function cached<T>(
  cache: Cache,
  namespace: string,
  keys: string[],
  fetchMissing: (keys: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T | null>> {
  const results = new Map<string, T | null>();
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    const hit = await cache.get<T>(namespace, key);
    if (hit === undefined) missing.push(key);
    else results.set(key, hit);
  }
  if (missing.length > 0) {
    const fetched = await fetchMissing(missing);
    for (const key of missing) {
      const value = fetched.get(key) ?? null;
      results.set(key, value);
      await cache.set(namespace, key, value);
    }
  }
  return results;
}
