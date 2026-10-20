import { cached, type Cache } from './cache.js';
import { chunk, mapLimit } from './concurrency.js';
import type { HttpClient } from './http.js';

const BASE_URL = 'https://api.npmjs.org/downloads/point/last-week';
// The bulk endpoint takes up to 128 packages, but not scoped ones.
const BULK_SIZE = 128;
const CONCURRENCY = 8;

type Point = { downloads: number } | null;

/** Weekly npm download counts (https://github.com/npm/registry/blob/main/docs/download-counts.md). */
export class NpmDownloadsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: Cache,
  ) {}

  getWeeklyDownloads(names: string[]): Promise<Map<string, number | null>> {
    return cached(this.cache, 'npm-downloads', names, async (missing) => {
      const results = new Map<string, number>();
      const scoped = missing.filter((name) => name.startsWith('@'));
      const unscoped = missing.filter((name) => !name.startsWith('@'));

      // A bulk request with a single name answers in the single-package format.
      const bulk = chunk(unscoped, BULK_SIZE);
      const single = bulk.at(-1)?.length === 1 ? [...scoped, ...bulk.pop()!] : scoped;

      await mapLimit(bulk, CONCURRENCY, async (names) => {
        const points = await this.http.getJson<Record<string, Point>>(
          `${BASE_URL}/${names.join(',')}`,
        );
        for (const [name, point] of Object.entries(points ?? {})) {
          if (point) results.set(name, point.downloads);
        }
      });
      await mapLimit(single, CONCURRENCY, async (name) => {
        const point = await this.http.getJson<Point>(`${BASE_URL}/${encodeURIComponent(name)}`);
        if (point) results.set(name, point.downloads);
      });
      return results;
    });
  }
}
