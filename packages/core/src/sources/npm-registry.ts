import { cached, type Cache } from './cache.js';
import { mapLimit } from './concurrency.js';
import type { HttpClient } from './http.js';

const BASE_URL = 'https://registry.npmjs.org';
const CONCURRENCY = 16;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface NpmPackageSize {
  unpackedSize?: number;
  fileCount?: number;
  /** Compressed size; only looked up when the registry has no `unpackedSize` (versions before ~2018). */
  tarballSize?: number;
}

interface Manifest {
  dist?: { unpackedSize?: number; fileCount?: number; tarball?: string };
}

/** The npm registry (https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md). */
export class NpmRegistryClient {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: Cache,
  ) {}

  /**
   * Size of each package's latest version. The registry serves single versions of scoped packages
   * only by dist-tag, so `latest` is what every package gets.
   */
  getLatestSizes(names: string[]): Promise<Map<string, NpmPackageSize | null>> {
    return cached(
      this.cache,
      'npm-latest-size',
      names,
      async (missing) => {
        const sizes = await mapLimit(missing, CONCURRENCY, async (name) => {
          const dist = (
            await this.http.getJson<Manifest>(`${BASE_URL}/${name.replace('/', '%2F')}/latest`)
          )?.dist;
          if (!dist) return undefined;
          const tarballSize =
            dist.unpackedSize === undefined && dist.tarball
              ? await this.http.getSize(dist.tarball)
              : undefined;
          const size: NpmPackageSize = {
            ...(dist.unpackedSize !== undefined && { unpackedSize: dist.unpackedSize }),
            ...(dist.fileCount !== undefined && { fileCount: dist.fileCount }),
            ...(tarballSize !== undefined && { tarballSize }),
          };
          return [name, size] as const;
        });
        return new Map(sizes.filter((entry) => entry !== undefined));
      },
      // Only inactive packages are looked up, and their latest version rarely changes.
      WEEK_MS,
    );
  }
}
