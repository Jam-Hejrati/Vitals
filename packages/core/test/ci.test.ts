import { describe, expect, it } from 'vitest';
import {
  buildReport,
  evaluateCi,
  packageNames,
  parseNpmLockfile,
  type PackageSignals,
} from '../src/index.js';

const now = new Date('2026-10-20T00:00:00Z');

const graph = parseNpmLockfile(
  JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', dependencies: { gone: '1', stale: '1', fine: '1', old: '1' } },
      'node_modules/gone': { version: '1.0.0' },
      'node_modules/stale': { version: '1.0.0' },
      'node_modules/fine': { version: '1.0.0' },
      'node_modules/old': { version: '1.0.0' },
    },
  }),
);

const signal = (name: string, overrides: Partial<PackageSignals> = {}): PackageSignals => ({
  id: `${name}@1.0.0`,
  name,
  version: '1.0.0',
  found: true,
  versionCount: 3,
  releasesLastYear: 1,
  stableReleasesLastYear: 1,
  dependencyCount: 0,
  licenses: ['MIT'],
  lastPublishedAt: '2026-09-20T00:00:00Z',
  ...overrides,
});

const report = buildReport(
  { lockfile: '/app/package-lock.json', kind: 'npm', graph },
  new Map(
    [
      signal('gone', { latestDeprecated: 'dead' }),
      signal('stale', { lastPublishedAt: '2020-01-01T00:00:00Z', unpackedSize: 900_000 }),
      signal('fine'),
      signal('old', { latestDeprecated: 'dead too' }),
    ].map((s) => [s.id, s]),
  ),
  { now },
);

describe('evaluateCi', () => {
  it('checks every package when there is no base', () => {
    const result = evaluateCi(report, { failOn: 'abandoned' });
    expect(result.newPackages).toBe(4);
    expect(result.offenders.map((p) => p.name)).toEqual(['gone', 'old']);
    expect(result.passed).toBe(false);
  });

  it('only counts packages that are not in the base', () => {
    const result = evaluateCi(report, {
      failOn: 'abandoned',
      base: 'origin/main',
      baseNames: new Set(['gone', 'fine']),
    });
    expect(result).toMatchObject({ base: 'origin/main', newPackages: 2 });
    expect(result.offenders.map((p) => p.name)).toEqual(['old']);
  });

  it('passes when the unhealthy packages were already there', () => {
    const result = evaluateCi(report, {
      failOn: 'stale',
      baseNames: new Set(['gone', 'old', 'stale', 'fine']),
    });
    expect(result).toMatchObject({ newPackages: 0, passed: true, offenders: [], watch: [] });
  });

  it('keeps problems below the threshold as a watch list instead of failing', () => {
    const result = evaluateCi(report, { failOn: 'abandoned', baseNames: new Set(['gone', 'old']) });
    expect(result.passed).toBe(true);
    expect(result.watch.map((p) => p.name)).toEqual(['stale']);
  });

  it('lets --fail-on stale fail on stale packages too', () => {
    const result = evaluateCi(report, { failOn: 'stale', baseNames: new Set(['gone', 'old']) });
    expect(result.passed).toBe(false);
    expect(result.offenders.map((p) => p.name)).toEqual(['stale']);
  });

  it('lets --fail-on deprecated ignore abandoned and stale packages', () => {
    const result = evaluateCi(report, {
      failOn: 'deprecated',
      baseNames: new Set(['gone', 'old']),
    });
    expect(result.passed).toBe(true);
  });
});

describe('packageNames', () => {
  it('lists the names of installed packages', () => {
    expect([...packageNames(graph)].sort()).toEqual(['fine', 'gone', 'old', 'stale']);
  });
});
