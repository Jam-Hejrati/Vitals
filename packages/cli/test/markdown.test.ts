import { buildReport, evaluateCi, parseNpmLockfile, type PackageSignals } from '@vitals/core';
import { describe, expect, it } from 'vitest';
import { escape, formatCiMarkdown, formatReportMarkdown, MARKER } from '../src/markdown.js';

const now = new Date('2026-10-20T00:00:00Z');

// app ─┬─ old ── inner
//      ├─ fine
//      └─ dusty
const graph = parseNpmLockfile(
  JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { old: '1', fine: '1', dusty: '1' } },
      'node_modules/old': { version: '1.0.0', dependencies: { inner: '1' } },
      'node_modules/inner': { version: '1.0.0' },
      'node_modules/fine': { version: '1.0.0' },
      'node_modules/dusty': { version: '1.0.0' },
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
      signal('old', { latestDeprecated: 'use <b>new</b> | [click](https://evil.test)' }),
      signal('inner', { latestDeprecated: 'gone' }),
      signal('fine'),
      signal('dusty', { lastPublishedAt: '2020-01-01T00:00:00Z', unpackedSize: 900_000 }),
    ].map((s) => [s.id, s]),
  ),
  { now },
);

describe('formatCiMarkdown', () => {
  const failing = evaluateCi(report, {
    failOn: 'abandoned',
    base: 'origin/main',
    baseNames: new Set(),
  });

  it('starts with a marker that says how the check went', () => {
    const text = formatCiMarkdown(report, failing);
    expect(text.startsWith(`${MARKER} status=fail -->\n`)).toBe(true);
    expect(text).toContain('### ❌ Vitals: 2 new dependencies are deprecated or abandoned');
    expect(text).toContain('Compared with `origin/main`: 4 new packages · fails on `abandoned`');
  });

  it('lists the offenders in a table, with where they come from', () => {
    const text = formatCiMarkdown(report, failing);
    expect(text).toContain(
      '| 🔴 | [`old@1.0.0`](https://www.npmjs.com/package/old/v/1.0.0) | **deprecated** |',
    );
    expect(text).toMatch(/\| 🔴 \| \[`inner@1\.0\.0`\].*\| `old` \|/);
  });

  it('folds what does not fail the check away', () => {
    const text = formatCiMarkdown(report, failing);
    expect(text).toContain(
      '<summary>1 more package worth a look (not failing the check)</summary>',
    );
    expect(text).toContain('**stale**');
  });

  it('passes with a warning when only smaller problems are new', () => {
    const passing = evaluateCi(report, {
      failOn: 'abandoned',
      base: 'origin/main',
      baseNames: new Set(['old', 'inner', 'fine']),
    });
    const text = formatCiMarkdown(report, passing);
    expect(text.startsWith(`${MARKER} status=warn -->`)).toBe(true);
    expect(text).toContain('### ✅ Vitals: no new dependency is deprecated or abandoned');
  });
});

describe('formatReportMarkdown', () => {
  it('summarizes the project and lists every problem', () => {
    const text = formatReportMarkdown(report);
    expect(text).toContain('4 packages checked (3 direct), **25% healthy**');
    expect(text).toContain('`dusty@1.0.0`');
    expect(text).not.toContain('`fine@1.0.0`');
  });
});

describe('escape', () => {
  it('keeps third-party text from becoming HTML, links or table cells', () => {
    expect(escape('use <b>new</b> | [click](https://evil.test) ![x](y)')).toBe(
      String.raw`use &lt;b&gt;new&lt;/b&gt; \| \[click\](https://evil.test) \!\[x\](y)`,
    );
    expect(formatReportMarkdown(report)).not.toContain('<b>');
  });
});
