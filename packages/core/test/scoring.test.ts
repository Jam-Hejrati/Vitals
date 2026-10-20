import { describe, expect, it } from 'vitest';
import { assess, formatAge, formatBytes, type PackageSignals } from '../src/index.js';

// Edge cases the golden set does not cover. Real-world behaviour is tested in golden.test.ts.

const now = new Date('2026-10-20T00:00:00Z');
const monthsAgo = (months: number) =>
  new Date(now.getTime() - months * 30.44 * 24 * 60 * 60 * 1000).toISOString();

const signals = (overrides: Partial<PackageSignals> = {}): PackageSignals => ({
  id: 'pkg@1.0.0',
  name: 'pkg',
  version: '1.0.0',
  found: true,
  lastPublishedAt: monthsAgo(36),
  versionCount: 10,
  releasesLastYear: 0,
  stableReleasesLastYear: 0,
  dependencyCount: 0,
  licenses: ['MIT'],
  weeklyDownloads: 1_000_000,
  unpackedSize: 500_000,
  repository: {
    id: 'github.com/o/pkg',
    openIssues: 5,
    commitsLast90Days: 0,
    issueActivityLast90Days: 0,
  },
  ...overrides,
});

describe('assess', () => {
  it('calls unmet demand stale, not abandoned, before the abandonment threshold', () => {
    const result = assess(
      signals({ lastPublishedAt: monthsAgo(18), repository: { id: 'r', openIssues: 50 } }),
      { now },
    );
    expect(result.verdict).toBe('stale');
  });

  it('only says "unanswered" when there was no issue activity', () => {
    const quiet = assess(
      signals({
        repository: { id: 'r', openIssues: 50, commitsLast90Days: 0, issueActivityLast90Days: 0 },
      }),
      { now },
    );
    const busy = assess(
      signals({
        repository: { id: 'r', openIssues: 50, commitsLast90Days: 0, issueActivityLast90Days: 4 },
      }),
      { now },
    );
    expect(quiet.reasons).toContain('50 open issues, unanswered for 1M weekly downloads');
    expect(busy.reasons).toContain('50 open issues for 1M weekly downloads');
  });

  it('does not count issues as unmet demand when usage is huge', () => {
    const result = assess(
      signals({
        unpackedSize: 5_000,
        weeklyDownloads: 300_000_000,
        repository: { id: 'r', openIssues: 40 },
      }),
      { now },
    );
    expect(result.verdict).toBe('finished');
  });

  it('never calls a package abandoned without evidence of neglect', () => {
    const result = assess(signals({ repository: undefined }), { now });
    expect(result.verdict).toBe('stale');
    expect(result.confidence).toBe('low');
    expect(result.unknowns).toContain('no source repository found');
  });

  it('reports missing size as unknown rather than guessing', () => {
    const result = assess(signals({ unpackedSize: undefined }), { now });
    expect(result.verdict).toBe('stale');
    expect(result.unknowns).toContain('package size');
  });

  it('counts recent commits as activity even without a recent release', () => {
    const result = assess(
      signals({ repository: { id: 'r', commitsLast90Days: 1, openIssues: 0 } }),
      { now },
    );
    expect(result.verdict).toBe('active');
    expect(result.reasons).toEqual(['1 commit in the last 90 days']);
  });

  it('accepts custom thresholds', () => {
    const result = assess(signals({ lastPublishedAt: monthsAgo(18) }), {
      now,
      thresholds: { activeWithinMonths: 24 },
    });
    expect(result.verdict).toBe('active');
  });

  it('shortens long deprecation messages to one line', () => {
    const result = assess(signals({ latestDeprecated: `Use X.\n\n${'details '.repeat(40)}` }), {
      now,
    });
    expect(result.reasons[0]).toMatch(/^deprecated: "Use X\. details .*…"$/);
    expect(result.reasons[0]).not.toContain('\n');
  });
});

describe('formatting', () => {
  it('formats ages', () => {
    expect(formatAge(0.5)).toBe('less than a month');
    expect(formatAge(1.2)).toBe('1 month');
    expect(formatAge(13)).toBe('13 months');
    expect(formatAge(30)).toBe('2 years');
  });

  it('formats sizes', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(1_300_000)).toBe('1.2 MB');
  });
});

describe('GitHub signals', () => {
  const inactive = (repository: object, overrides: Partial<PackageSignals> = {}) =>
    assess(
      signals({
        repository: {
          id: 'r',
          openIssues: 2,
          commitsLast90Days: 0,
          issueActivityLast90Days: 0,
          ...repository,
        },
        ...overrides,
      }),
      { now },
    );

  it('treats an archived repository as evidence of neglect for a sizeable package', () => {
    const result = inactive({ archived: true });
    expect(result.verdict).toBe('abandoned');
    expect(result.reasons).toContain('repository is archived (read-only)');
  });

  it('lets a small archived package be finished', () => {
    const result = inactive({ archived: true }, { unpackedSize: 4_000 });
    expect(result.verdict).toBe('finished');
    expect(result.reasons).toContain('repository is archived (read-only)');
  });

  it('only warns about an archived repository when the package is still released', () => {
    const result = inactive({ archived: true }, { lastPublishedAt: monthsAgo(3) });
    expect(result.verdict).toBe('active');
    expect(result.warnings.map((w) => w.code)).toEqual(['archived']);
  });

  it('warns about a single maintainer without changing the verdict', () => {
    const result = inactive({
      commitsLast90Days: 4,
      committers: 1,
      topCommitterShare: 1,
      sampledCommits: 40,
    });
    expect(result.verdict).toBe('active');
    expect(result.warnings).toEqual([
      { code: 'single-maintainer', message: 'one person wrote 100% of the last 40 commits' },
    ]);
  });

  it('does not call a package single-maintainer on too little evidence', () => {
    const result = inactive({ commitsLast90Days: 1, topCommitterShare: 1, sampledCommits: 3 });
    expect(result.warnings).toEqual([]);
  });
});

describe('small packages and open issues', () => {
  const withIssues = (openIssues: number, overrides: Partial<PackageSignals> = {}) =>
    assess(
      signals({
        unpackedSize: 5_000,
        weeklyDownloads: 20_000_000,
        repository: { id: 'r', openIssues, commitsLast90Days: 0, issueActivityLast90Days: 0 },
        ...overrides,
      }),
      { now },
    );

  it('lets a small package with a moderate backlog be finished', () => {
    // 60 issues for 20M downloads is 3 per million: enough to worry about a large package.
    expect(withIssues(60).verdict).toBe('finished');
    expect(withIssues(60, { unpackedSize: 900_000 }).verdict).toBe('abandoned');
  });

  it('still calls a small package abandoned when the backlog is overwhelming', () => {
    // 150 issues for 20M downloads is 7.5 per million.
    expect(withIssues(150).verdict).toBe('abandoned');
  });

  it('does not count a handful of issues against a small package', () => {
    expect(withIssues(25, { weeklyDownloads: 1_000_000 }).verdict).toBe('finished');
  });
});
