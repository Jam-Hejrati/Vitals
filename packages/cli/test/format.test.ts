import {
  buildReport,
  evaluateCi,
  packageNames,
  parseNpmLockfile,
  type PackageSignals,
} from '@vitals/core';
import { describe, expect, it } from 'vitest';
import { formatCi, formatReport } from '../src/format.js';

const now = new Date('2026-10-20T00:00:00Z');

const extras = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const entry = (version = '1.0.0', dependencies: string[] = []) => ({
  version,
  dependencies: Object.fromEntries(dependencies.map((name) => [name, '1'])),
});

// old ─┬─ inner, c1..c6   (7 problems only `old` is responsible for)
// fine ─ leaf            (a healthy package that brings in a problem)
// p, q ─ shared          (a problem brought in by two dependencies)
const graph = parseNpmLockfile(
  JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'app',
        version: '1.0.0',
        dependencies: { old: '1', fine: '1', p: '1', q: '1' },
      },
      'node_modules/old': entry('1.0.0', ['inner', ...extras]),
      'node_modules/inner': entry(),
      ...Object.fromEntries(extras.map((name) => [`node_modules/${name}`, entry()])),
      'node_modules/fine': entry('1.0.0', ['leaf']),
      'node_modules/leaf': entry(),
      'node_modules/p': entry('1.0.0', ['shared']),
      'node_modules/q': entry('1.0.0', ['shared']),
      'node_modules/shared': entry(),
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
const stale = { lastPublishedAt: '2020-01-01T00:00:00Z', unpackedSize: 900_000 };

const reportFor = (signals: PackageSignals[]) =>
  buildReport(
    { lockfile: '/app/package-lock.json', kind: 'npm', graph },
    new Map(signals.map((s) => [s.id, s])),
    { now },
  );

const healthy = [signal('fine'), signal('p'), signal('q')];
const problems = reportFor([
  ...healthy,
  signal('old', { latestDeprecated: 'use new' }),
  signal('inner', { latestDeprecated: 'gone' }),
  ...extras.map((name) => signal(name, stale)),
  signal('leaf', stale),
  signal('shared', stale),
]);

const plain = { all: false, color: false };

describe('formatReport', () => {
  const text = formatReport(problems, plain);

  it('groups problems under the direct dependency that brings them in', () => {
    expect(text).toContain('old@1.0.0  DEPRECATED  (direct)');
    expect(text).toContain('Also brings in 7 packages that need attention:');
    expect(text).toContain('✖ inner@1.0.0  deprecated');
  });

  it('shows a healthy dependency that brings in a problem', () => {
    expect(text).toContain('fine@1.0.0  (direct)');
    expect(text).toContain('Brings in 1 package that needs attention:');
    expect(text).toContain('▲ leaf@1.0.0  stale');
  });

  it('lists problems brought in by several dependencies separately, with their sources', () => {
    expect(text).toContain('Shared by several dependencies');
    expect(text).toMatch(/shared@1\.0\.0 {2}stale .*via p, q/);
  });

  it('puts the worst problems first', () => {
    expect(text.indexOf('old@1.0.0  DEPRECATED')).toBeLessThan(text.indexOf('fine@1.0.0'));
  });

  it('caps nested problems unless asked for everything', () => {
    expect(text).toContain('…and 2 more (use --all)');
    expect(text).not.toContain('c6@1.0.0');
    expect(formatReport(problems, { ...plain, all: true })).toContain('c6@1.0.0');
  });

  it('summarizes and says what was left out', () => {
    expect(text).toContain('Vitals · app · package-lock.json');
    expect(text).toContain('13 packages checked (4 direct)');
    expect(text).toContain('2 deprecated · 8 stale · 3 active');
    expect(text).toContain('Not shown: 2 healthy or unassessed packages. Use --all to list them.');
  });

  it('lists the healthy packages too with --all', () => {
    const everything = formatReport(problems, { ...plain, all: true });
    expect(everything).toContain('Everything else:');
    expect(everything).toContain('✔ p@1.0.0  active');
    expect(everything).not.toContain('Not shown');
  });
});

describe('formatReport without problems', () => {
  const clean = reportFor([signal('old'), signal('inner'), ...healthy]);

  it('says so', () => {
    const text = formatReport(clean, plain);
    expect(text).toContain('✔ No dependency needs attention.');
    expect(text).toContain('5 active');
  });

  it('only emits color codes when asked to', () => {
    expect(formatReport(problems, plain)).not.toContain('\x1b[');
    expect(formatReport(problems, { ...plain, color: true })).toContain('\x1b[31m');
  });
});

describe('formatReport replacements', () => {
  const lockfile = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { 'left-pad': '1', moment: '1' } },
      'node_modules/left-pad': { version: '1.0.0' },
      'node_modules/moment': { version: '1.0.0' },
    },
  });
  const report = buildReport(
    { lockfile: '/app/package-lock.json', kind: 'npm', graph: parseNpmLockfile(lockfile) },
    new Map(
      [signal('left-pad', { latestDeprecated: 'use padStart' }), signal('moment')].map((s) => [
        s.id,
        s,
      ]),
    ),
    { now },
  );

  it('suggests what to use instead for packages that need attention', () => {
    const text = formatReport(report, plain);
    expect(text).toContain('→ instead: String.prototype.padStart (built in)');
  });

  it('does not nag about healthy packages unless asked for everything', () => {
    expect(formatReport(report, plain)).not.toContain('date-fns');
    expect(formatReport(report, { ...plain, all: true })).toContain('instead: day.js, date-fns');
  });
});

describe('formatReport GitHub notices', () => {
  const lockfile = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { solo: '1', gone: '1', team: '1' } },
      'node_modules/solo': { version: '1.0.0' },
      'node_modules/gone': { version: '1.0.0' },
      'node_modules/team': { version: '1.0.0' },
    },
  });
  const repo = (extra: object) => ({ id: 'github.com/o/r', ...extra });
  const report = buildReport(
    { lockfile: '/app/package-lock.json', kind: 'npm', graph: parseNpmLockfile(lockfile) },
    new Map(
      [
        signal('solo', {
          repository: repo({ commitsLast90Days: 5, topCommitterShare: 1, sampledCommits: 30 }),
        }),
        signal('gone', { repository: repo({ archived: true }) }),
        signal('team', {
          repository: repo({ commitsLast90Days: 5, topCommitterShare: 0.4, sampledCommits: 30 }),
        }),
      ].map((s) => [s.id, s]),
    ),
    { now },
  );

  it('lists healthy direct dependencies that are archived or have a single maintainer', () => {
    const text = formatReport(report, { ...plain, github: true });
    expect(text).toContain('Archived repositories (no further fixes expected):\n  gone');
    expect(text).toContain('Maintained by one person (direct dependencies):\n  solo');
    expect(text).not.toContain('team,');
    expect(text).not.toContain('Tip:');
  });

  it('tells users without a token how to get these checks', () => {
    expect(formatReport(report, { ...plain, github: false })).toContain('Tip: set GITHUB_TOKEN');
  });
});

describe('formatCi', () => {
  const base = new Set(['fine', 'p', 'q']);
  const failing = evaluateCi(problems, {
    failOn: 'abandoned',
    base: 'origin/main',
    baseNames: base,
  });

  it('groups what a pull request adds under the dependency that brings it in', () => {
    const text = formatCi(problems, failing, plain);
    expect(text).toContain('Compared with origin/main: 10 new packages');
    expect(text).toContain('old@1.0.0  DEPRECATED  (direct)');
    expect(text).toContain('Also brings in 1 package that needs attention:');
    expect(text).toContain('✖ inner@1.0.0  deprecated');
    expect(text).toContain(
      '✖ Failed: 2 new dependencies are deprecated or abandoned (--fail-on abandoned).',
    );
  });

  it('keeps problems below the threshold out of the failure', () => {
    const text = formatCi(problems, failing, plain);
    expect(text).toContain('Worth a look (not failing the check):');
    expect(text).toContain('c1@1.0.0  stale');
  });

  it('passes when nothing new is wrong', () => {
    const passing = evaluateCi(problems, {
      failOn: 'abandoned',
      base: 'HEAD',
      baseNames: packageNames(graph),
    });
    const text = formatCi(problems, passing, plain);
    expect(text).toContain('Compared with HEAD: 0 new packages');
    expect(text).toContain('✔ Passed: no new dependency is deprecated or abandoned.');
  });

  it('says so when no base was given', () => {
    const text = formatCi(problems, evaluateCi(problems, { failOn: 'stale' }), plain);
    expect(text).toContain('No base given: checking all 13 packages');
    expect(text).toContain('(--fail-on stale)');
  });
});
