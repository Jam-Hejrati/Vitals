import { describe, expect, it } from 'vitest';
import { collectSignals, HttpClient, MemoryCache, parseNpmLockfile } from '../src/index.js';
import { fakeFetch } from './fake-fetch.js';

const graph = parseNpmLockfile(
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { old: '1', lib: '*', git: '*' } },
      'node_modules/old': { version: '1.0.0' },
      'node_modules/lib': { resolved: 'packages/lib', link: true },
      'packages/lib': { name: 'lib', version: '0.1.0' },
      'node_modules/git': { version: 'git+ssh://git@github.com/o/git.git#abc' },
    },
  }),
);

const version = (v: string, publishedAt: string, extra = {}) => ({
  versionKey: { version: v },
  publishedAt,
  ...extra,
});

const routes = {
  'https://api.deps.dev/v3/systems/npm/packages/old': () => ({
    versions: [
      version('1.0.0', '2018-01-01T00:00:00Z'),
      version('2.0.0', '2025-12-01T00:00:00Z', {
        isDefault: true,
        isDeprecated: true,
        deprecatedReason: 'moved to new-old',
      }),
      version('3.0.0-beta.1', '2026-03-01T00:00:00Z'),
    ],
  }),
  'https://api.deps.dev/v3alpha/versionbatch': ({ body }: { body: unknown }) => ({
    responses: (body as { requests: { versionKey: { name: string; version: string } }[] }).requests
      .filter((r) => r.versionKey.name === 'old')
      .map((r) => ({
        version: {
          versionKey: r.versionKey,
          licenses: [r.versionKey.version === '1.0.0' ? 'ISC' : 'MIT'],
          relatedProjects: [
            {
              projectKey: { id: `github.com/o/old-v${r.versionKey.version[0]}` },
              relationType: 'SOURCE_REPO',
            },
          ],
        },
      })),
  }),
  'https://api.deps.dev/v3alpha/projectbatch': () => ({
    responses: [
      {
        request: { projectKey: { id: 'github.com/o/old-v2' } },
        project: {
          openIssuesCount: 12,
          starsCount: 300,
          scorecard: {
            date: '2026-08-24T00:00:00Z',
            overallScore: 4.2,
            checks: [
              {
                name: 'Maintained',
                score: 0,
                reason:
                  '1 commit(s) and 3 issue activity found in the last 90 days -- score normalized to 0',
              },
            ],
          },
        },
      },
    ],
  }),
  'https://api.npmjs.org/downloads/point/last-week/old': () => ({ downloads: 1234 }),
};

describe('collectSignals', () => {
  it('combines registry, repository and download signals', async () => {
    const fetch = fakeFetch(routes);
    const signals = await collectSignals(graph, {
      http: new HttpClient({ fetch, retryDelayMs: 0 }),
      cache: new MemoryCache(),
      now: new Date('2026-10-20T00:00:00Z'),
    });

    expect([...signals.keys()]).toEqual(['old@1.0.0']);
    expect(signals.get('old@1.0.0')).toEqual({
      id: 'old@1.0.0',
      name: 'old',
      version: '1.0.0',
      found: true,
      installedPublishedAt: '2018-01-01T00:00:00Z',
      latestVersion: '2.0.0',
      latestDeprecated: 'moved to new-old',
      firstPublishedAt: '2018-01-01T00:00:00Z',
      lastPublishedAt: '2026-03-01T00:00:00Z',
      versionCount: 3,
      releasesLastYear: 2,
      licenses: ['ISC'],
      weeklyDownloads: 1234,
      repository: {
        id: 'github.com/o/old-v2',
        openIssues: 12,
        stars: 300,
        scorecardScore: 4.2,
        scorecardDate: '2026-08-24T00:00:00Z',
        maintainedScore: 0,
        commitsLast90Days: 1,
        issueActivityLast90Days: 3,
      },
    });
  });

  it('reports packages deps.dev does not know', async () => {
    const fetch = fakeFetch({ 'https://api.deps.dev/v3alpha/': () => ({ responses: [] }) });
    const signals = await collectSignals(graph, {
      http: new HttpClient({ fetch, retryDelayMs: 0 }),
      cache: new MemoryCache(),
    });
    expect(signals.get('old@1.0.0')).toEqual({
      id: 'old@1.0.0',
      name: 'old',
      version: '1.0.0',
      found: false,
      versionCount: 0,
      releasesLastYear: 0,
      licenses: [],
    });
  });
});
