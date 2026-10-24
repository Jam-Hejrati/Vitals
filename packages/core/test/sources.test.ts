import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCache, HttpClient, HttpError, MemoryCache } from '../src/index.js';
import { GitHubClient } from '../src/sources/github.js';
import { DepsDevClient } from '../src/sources/depsdev.js';
import { NpmDownloadsClient } from '../src/sources/npm-downloads.js';
import { NpmRegistryClient } from '../src/sources/npm-registry.js';
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

  it('reads a resource size from a one-byte range request', async () => {
    const fetch = fakeFetch({
      'https://x.test/': () =>
        new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/1979' } }),
    });
    expect(await http(fetch).getSize('https://x.test/pkg.tgz')).toBe(1979);
  });

  describe('a slow GET', () => {
    /** A fetch whose first call hangs until aborted; later calls answer at once. */
    const hangingFirst = () => {
      const calls: { aborted: () => boolean }[] = [];
      const fetch = (_url: string, init?: RequestInit) => {
        const signal = init!.signal!;
        calls.push({ aborted: () => signal.aborted });
        if (calls.length > 1) return Promise.resolve(Response.json({ call: calls.length }));
        return new Promise<Response>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
      };
      return { fetch, calls };
    };

    it('gets a twin request, and the first answer wins', async () => {
      const { fetch, calls } = hangingFirst();
      const client = new HttpClient({ fetch, hedgeMs: 10, retries: 0 });
      expect(await client.getJson('https://x.test/slow')).toEqual({ call: 2 });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.aborted()).toBe(true);
    });

    it('is not hedged when it answers in time', async () => {
      const fetch = fakeFetch({ 'https://x.test/': () => ({ ok: true }) });
      await new HttpClient({ fetch, hedgeMs: 10 }).getJson('https://x.test/fast');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetch.requests).toHaveLength(1);
    });

    it('still fails at once when the only request fails', async () => {
      const fetch = () => Promise.reject(new Error('offline'));
      const client = new HttpClient({ fetch, hedgeMs: 60_000, retries: 0 });
      await expect(client.getJson('https://x.test/')).rejects.toThrow('offline');
    });
  });

  it('does not hedge POST requests', async () => {
    let calls = 0;
    const slow = () => {
      calls++;
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(Response.json({ ok: true })), 30),
      );
    };
    await new HttpClient({ fetch: slow, hedgeMs: 5 }).postJson('https://x.test/', {});
    expect(calls).toBe(1);
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

describe('NpmRegistryClient', () => {
  it('reads sizes of the latest version, falling back to the tarball size', async () => {
    const fetch = fakeFetch({
      'https://registry.npmjs.org/@s%2Fnew/latest': () => ({
        dist: { unpackedSize: 4096, fileCount: 3 },
      }),
      'https://registry.npmjs.org/old/latest': () => ({
        dist: { tarball: 'https://registry.npmjs.org/old/-/old-1.0.0.tgz' },
      }),
      'https://registry.npmjs.org/old/-/': () =>
        new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/2030' } }),
    });
    const client = new NpmRegistryClient(http(fetch), new MemoryCache());

    const sizes = await client.getLatestSizes(['@s/new', 'old', 'missing']);
    expect(Object.fromEntries(sizes)).toEqual({
      '@s/new': { unpackedSize: 4096, fileCount: 3 },
      old: { tarballSize: 2030 },
      missing: null,
    });
  });
});

describe('NpmRegistryClient failures', () => {
  it('reports a size as unknown, without caching it, when the lookup fails', async () => {
    let down = true;
    const fetch = fakeFetch({
      'https://registry.npmjs.org/flaky/latest': () =>
        down ? new Response('', { status: 503 }) : { dist: { unpackedSize: 10 } },
    });
    const client = new NpmRegistryClient(http(fetch), new MemoryCache());

    expect((await client.getLatestSizes(['flaky'])).get('flaky')).toBeNull();
    down = false;
    expect((await client.getLatestSizes(['flaky'])).get('flaky')).toEqual({ unpackedSize: 10 });
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

  it('survives rate limiting and retries the failed names on the next run', async () => {
    let limited = true;
    const fetch = fakeFetch({
      'https://api.npmjs.org/downloads/point/last-week/': () =>
        limited ? new Response('', { status: 429 }) : { downloads: 7 },
    });
    const client = new NpmDownloadsClient(http(fetch), new MemoryCache());

    expect((await client.getWeeklyDownloads(['@s/c'])).get('@s/c')).toBeNull();
    limited = false;
    expect((await client.getWeeklyDownloads(['@s/c'])).get('@s/c')).toBe(7);
  });

  it('asks for a lone unscoped name in the single-package format', async () => {
    const fetch = fakeFetch({
      'https://api.npmjs.org/downloads/point/last-week/a': () => ({ downloads: 5 }),
    });
    const client = new NpmDownloadsClient(http(fetch), new MemoryCache());
    expect((await client.getWeeklyDownloads(['a'])).get('a')).toBe(5);
  });
});

describe('GitHubClient', () => {
  const commit = (login: string, type = 'User') => ({ author: { login, type } });
  const client = (fetch: ReturnType<typeof fakeFetch>) =>
    new GitHubClient(http(fetch), new MemoryCache(), 'token', () =>
      Date.parse('2026-10-20T00:00:00Z'),
    );

  it('reports archived repositories and who actually commits, ignoring bots', async () => {
    const fetch = fakeFetch({
      'https://api.github.com/repos/o/dead': () => ({ archived: true }),
      'https://api.github.com/repos/o/solo/commits': () => [
        ...Array.from({ length: 9 }, () => commit('alice')),
        commit('bob'),
        commit('dependabot[bot]', 'Bot'),
        commit('renovate', 'Bot'),
      ],
      'https://api.github.com/repos/o/solo': () => ({ archived: false }),
    });
    const repositories = await client(fetch).getRepositories([
      'github.com/o/dead',
      'github.com/o/solo',
      'gitlab.com/o/elsewhere',
    ]);

    expect(Object.fromEntries(repositories)).toEqual({
      'github.com/o/dead': { archived: true },
      'github.com/o/solo': {
        archived: false,
        committers: 2,
        topCommitterShare: 0.9,
        sampledCommits: 10,
      },
    });
    // Archived repositories need no commit history, and other hosts are not asked about.
    expect(fetch.requests.map((r) => r.url.split('?')[0])).not.toContain(
      'https://api.github.com/repos/o/dead/commits',
    );
    expect(fetch.requests.some((r) => r.url.includes('gitlab'))).toBe(false);
  });

  it('stops asking and reports the rest as unknown when rate limited', async () => {
    const fetch = fakeFetch({
      'https://api.github.com/': () => new Response('', { status: 403 }),
    });
    const repositories = await client(fetch).getRepositories(
      Array.from({ length: 30 }, (_, i) => `github.com/o/r${i}`),
    );
    expect([...repositories.values()].every((value) => value === null)).toBe(true);
    expect(fetch.requests.length).toBeLessThan(30);
  });

  it('reports an invalid token as an error', async () => {
    const fetch = fakeFetch({
      'https://api.github.com/': () => new Response('', { status: 401 }),
    });
    await expect(client(fetch).getRepositories(['github.com/o/r'])).rejects.toThrow(
      /rejected the token/,
    );
  });
});
