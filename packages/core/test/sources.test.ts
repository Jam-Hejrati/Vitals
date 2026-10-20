import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCache, HttpClient, HttpError, MemoryCache } from '../src/index.js';
import { DepsDevClient } from '../src/sources/depsdev.js';
import { NpmDownloadsClient } from '../src/sources/npm-downloads.js';
import { fakeFetch } from './fake-fetch.js';

const http = (fetch: ReturnType<typeof fakeFetch>) =>
  new HttpClient({ fetch, retryDelayMs: 0, retries: 2 });

describe('HttpClient', () => {
  it('returns undefined for 404', async () => {
    const fetch = fakeFetch({});
    expect(await http(fetch).getJson('https://x.test/missing')).toBeUndefined();
  });

  it('retries server errors and rate limits', async () => {
    const statuses = [503, 429];
    const fetch = fakeFetch({
      'https://x.test/': () => {
        const status = statuses.shift();
        return status ? new Response('', { status }) : { ok: true };
      },
    });
    expect(await http(fetch).getJson('https://x.test/flaky')).toEqual({ ok: true });
    expect(fetch.requests).toHaveLength(3);
  });

  it('gives up after the configured retries', async () => {
    const fetch = fakeFetch({ 'https://x.test/': () => new Response('', { status: 500 }) });
    await expect(http(fetch).getJson('https://x.test/down')).rejects.toThrow(HttpError);
    expect(fetch.requests).toHaveLength(3);
  });

  it('does not retry client errors', async () => {
    const fetch = fakeFetch({ 'https://x.test/': () => new Response('', { status: 400 }) });
    await expect(http(fetch).getJson('https://x.test/bad')).rejects.toThrow('HTTP 400');
    expect(fetch.requests).toHaveLength(1);
  });
});

describe('FileCache', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('stores values and not-found markers until they expire', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vitals-cache-'));
    let now = 1_000;
    const cache = new FileCache(dir, 100, () => now);

    await cache.set('ns', 'a', { value: 1 });
    await cache.set('ns', 'b', null);
    expect(await cache.get('ns', 'a')).toEqual({ value: 1 });
    expect(await cache.get('ns', 'b')).toBeNull();
    expect(await cache.get('ns', 'c')).toBeUndefined();

    now += 101;
    expect(await cache.get('ns', 'a')).toBeUndefined();
  });
});

describe('DepsDevClient', () => {
  it('fetches packages with encoded names and caches them, including not found', async () => {
    const fetch = fakeFetch({
      'https://api.deps.dev/v3/systems/npm/packages/%40scope%2Fpkg': () => ({
        versions: [
          {
            versionKey: { version: '1.0.0' },
            publishedAt: '2020-01-01T00:00:00Z',
            isDefault: true,
            isDeprecated: true,
            deprecatedReason: 'use other',
          },
        ],
      }),
    });
    const client = new DepsDevClient(http(fetch), new MemoryCache());

    const first = await client.getPackages(['@scope/pkg', 'missing']);
    expect(first.get('@scope/pkg')).toEqual({
      name: '@scope/pkg',
      versions: [
        {
          version: '1.0.0',
          publishedAt: '2020-01-01T00:00:00Z',
          isDefault: true,
          deprecatedReason: 'use other',
        },
      ],
    });
    expect(first.get('missing')).toBeNull();

    await client.getPackages(['@scope/pkg', 'missing']);
    expect(fetch.requests).toHaveLength(2);
  });

  it('follows batch pagination and keeps the source repository', async () => {
    const fetch = fakeFetch({
      'https://api.deps.dev/v3alpha/versionbatch': ({ body }) => {
        const { pageToken } = body as { pageToken?: string };
        const version = (name: string) => ({
          request: {},
          version: {
            versionKey: { name, version: '1.0.0' },
            licenses: ['MIT'],
            relatedProjects: [
              { projectKey: { id: 'github.com/o/issues' }, relationType: 'ISSUE_TRACKER' },
              { projectKey: { id: `github.com/o/${name}` }, relationType: 'SOURCE_REPO' },
            ],
          },
        });
        return pageToken
          ? { responses: [version('b')] }
          : { responses: [version('a')], nextPageToken: 'page-2' };
      },
    });
    const client = new DepsDevClient(http(fetch), new MemoryCache());

    const details = await client.getVersionDetails([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '1.0.0' },
    ]);
    expect(details.get('a@1.0.0')).toEqual({
      licenses: ['MIT'],
      sourceRepository: 'github.com/o/a',
    });
    expect(details.get('b@1.0.0')?.sourceRepository).toBe('github.com/o/b');
    expect(fetch.requests.map((r) => (r.body as { pageToken?: string }).pageToken)).toEqual([
      undefined,
      'page-2',
    ]);
  });
});

describe('NpmDownloadsClient', () => {
  it('uses bulk requests for unscoped names and single requests otherwise', async () => {
    const fetch = fakeFetch({
      'https://api.npmjs.org/downloads/point/last-week/a,b': () => ({
        a: { downloads: 10 },
        b: null,
      }),
      'https://api.npmjs.org/downloads/point/last-week/%40s%2Fc': () => ({ downloads: 30 }),
    });
    const client = new NpmDownloadsClient(http(fetch), new MemoryCache());

    const downloads = await client.getWeeklyDownloads(['a', 'b', '@s/c']);
    expect(Object.fromEntries(downloads)).toEqual({ a: 10, b: null, '@s/c': 30 });
    expect(fetch.requests).toHaveLength(2);
  });

  it('asks for a lone unscoped name in the single-package format', async () => {
    const fetch = fakeFetch({
      'https://api.npmjs.org/downloads/point/last-week/a': () => ({ downloads: 5 }),
    });
    const client = new NpmDownloadsClient(http(fetch), new MemoryCache());
    expect((await client.getWeeklyDownloads(['a'])).get('a')).toBe(5);
  });
});
