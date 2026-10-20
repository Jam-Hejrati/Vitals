import { describe, expect, it } from 'vitest';
import { buildReport, parseNpmLockfile, type PackageSignals, type Project } from '../src/index.js';

const now = new Date('2026-10-20T00:00:00Z');

const graph = parseNpmLockfile(
  JSON.stringify({
    name: 'app',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.2.3', dependencies: { a: '1', b: '1' } },
      'node_modules/a': { version: '1.0.0', dependencies: { x: '1' } },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/x': { version: '1.0.0', dependencies: { target: '1' } },
      'node_modules/target': { version: '1.0.0', dev: true },
    },
  }),
);
const project: Project = { lockfile: '/work/app/package-lock.json', kind: 'npm', graph };

const signal = (name: string, overrides: Partial<PackageSignals> = {}): PackageSignals => ({
  id: `${name}@1.0.0`,
  name,
  version: '1.0.0',
  found: true,
  versionCount: 3,
  releasesLastYear: 0,
  stableReleasesLastYear: 0,
  dependencyCount: 0,
  licenses: ['MIT'],
  lastPublishedAt: '2022-01-01T00:00:00Z',
  unpackedSize: 900_000,
  ...overrides,
});

const signals = new Map(
  [
    signal('a', { lastPublishedAt: '2026-09-20T00:00:00Z' }),
    signal('x'),
    signal('target', { latestDeprecated: 'use something else' }),
    signal('b', { latestDeprecated: 'gone' }),
  ].map((s) => [s.id, s]),
);

describe('buildReport', () => {
  const report = buildReport(project, signals, { now });

  it('describes the project and the run', () => {
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(report.project).toEqual({
      name: 'app',
      version: '1.2.3',
      lockfile: 'package-lock.json',
      packageManager: 'npm',
    });
  });

  it('lists the worst packages first, direct dependencies before transitive ones', () => {
    expect(report.packages.map((p) => `${p.verdict}:${p.id}`)).toEqual([
      'deprecated:b@1.0.0',
      'deprecated:target@1.0.0',
      'stale:x@1.0.0',
      'active:a@1.0.0',
    ]);
  });

  it('counts verdicts, packages and direct dependencies', () => {
    expect(report.summary).toEqual({
      total: 4,
      direct: 2,
      verdicts: { deprecated: 2, abandoned: 0, stale: 1, unknown: 0, finished: 0, active: 1 },
    });
  });

  it('explains why transitive packages are installed', () => {
    const target = report.packages.find((p) => p.id === 'target@1.0.0');
    expect(target).toMatchObject({
      direct: false,
      dev: true,
      paths: [['a@1.0.0', 'x@1.0.0', 'target@1.0.0']],
    });
    expect(report.packages.find((p) => p.id === 'b@1.0.0')).toMatchObject({
      direct: true,
      paths: [],
    });
  });

  it('survives a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
