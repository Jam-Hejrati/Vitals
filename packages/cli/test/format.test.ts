import { buildReport, parseNpmLockfile, type PackageSignals } from '@vitals/core';
import { describe, expect, it } from 'vitest';
import { formatReport } from '../src/format.js';

const now = new Date('2026-10-20T00:00:00Z');

const graph = parseNpmLockfile(
  JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { old: '1', fine: '1' } },
      'node_modules/old': { version: '1.0.0', dependencies: { inner: '1' } },
      'node_modules/inner': { version: '1.0.0' },
      'node_modules/fine': { version: '1.0.0' },
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

const reportFor = (...signals: PackageSignals[]) =>
  buildReport(
    { lockfile: '/app/package-lock.json', kind: 'npm', graph },
    new Map(signals.map((s) => [s.id, s])),
    { now },
  );

const problems = reportFor(
  signal('old', { latestDeprecated: 'use new' }),
  signal('inner', { latestDeprecated: 'gone' }),
  signal('fine'),
);

describe('formatReport', () => {
  it('shows only packages that need attention by default', () => {
    const text = formatReport(problems, { all: false, color: false });
    expect(text).toContain('Vitals · app · package-lock.json');
    expect(text).toContain('3 packages checked (2 direct)');
    expect(text).toContain('old@1.0.0  DEPRECATED  (direct)');
    expect(text).toContain('inner@1.0.0  DEPRECATED');
    expect(text).toContain('via old');
    expect(text).not.toContain('fine@1.0.0');
    expect(text).toContain('2 deprecated · 1 active');
    expect(text).toContain('Not shown: 1 healthy or unassessed packages. Use --all to list them.');
  });

  it('lists everything with --all', () => {
    const text = formatReport(problems, { all: true, color: false });
    expect(text).toContain('fine@1.0.0  ACTIVE  (direct)');
    expect(text).not.toContain('Not shown');
  });

  it('says so when nothing needs attention', () => {
    const text = formatReport(reportFor(signal('old'), signal('inner'), signal('fine')), {
      all: false,
      color: false,
    });
    expect(text).toContain('✔ No dependency needs attention.');
    expect(text).toContain('3 active');
  });

  it('only emits color codes when asked to', () => {
    expect(formatReport(problems, { all: false, color: false })).not.toContain('\x1b[');
    expect(formatReport(problems, { all: false, color: true })).toContain('\x1b[31m');
  });
});
