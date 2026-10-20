import type { PackageSignals } from './signals.js';

export type Verdict = 'deprecated' | 'abandoned' | 'stale' | 'finished' | 'active' | 'unknown';

/** How much evidence the verdict rests on. */
export type Confidence = 'high' | 'medium' | 'low';

/** Something worth knowing that does not change the verdict. */
export interface Warning {
  code: 'archived' | 'single-maintainer';
  message: string;
}

export interface Assessment {
  id: string;
  verdict: Verdict;
  /** 0–100, higher is healthier. Absent when the package could not be assessed. */
  score?: number;
  confidence: Confidence;
  /** The evidence behind the verdict, in plain language. */
  reasons: string[];
  /** Evidence that was missing, so users know what the verdict could not take into account. */
  unknowns: string[];
  /** What the user can do about it. */
  advice: string[];
  warnings: Warning[];
}

export interface Thresholds {
  /** A release within this many months makes a package active. */
  activeWithinMonths: number;
  /** Inactive this long, with unmet demand, makes a package abandoned. */
  abandonedAfterMonths: number;
  /** At most this unpacked size counts as small enough to be finished. */
  smallUnpackedBytes: number;
  /** Same, for old versions where only the compressed size is known. */
  smallTarballBytes: number;
  /** Unmet demand needs at least this many open issues... */
  unmetDemandMinIssues: number;
  /** ...and at least this many per million weekly downloads, so huge packages are not penalised. */
  unmetDemandIssuesPerMillionDownloads: number;
  /** A single maintainer is only called out with at least this many recent commits to go on... */
  singleMaintainerMinCommits: number;
  /** ...and when one person wrote at least this share of them (0–1). */
  singleMaintainerShare: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  activeWithinMonths: 12,
  abandonedAfterMonths: 24,
  smallUnpackedBytes: 150_000,
  smallTarballBytes: 40_000,
  unmetDemandMinIssues: 20,
  unmetDemandIssuesPerMillionDownloads: 1,
  singleMaintainerMinCommits: 10,
  singleMaintainerShare: 0.9,
};

export interface AssessOptions {
  now?: Date;
  thresholds?: Partial<Thresholds>;
}

const MONTH_MS = (365.25 / 12) * 24 * 60 * 60 * 1000;

/** Turns the raw signals of one package into a verdict with reasons. */
export function assess(signals: PackageSignals, options: AssessOptions = {}): Assessment {
  const t = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const now = (options.now ?? new Date()).getTime();
  const warnings: Warning[] = [];
  const result = (
    verdict: Verdict,
    score: number | undefined,
    confidence: Confidence,
    reasons: string[],
    unknowns: string[] = [],
    advice: string[] = [],
  ): Assessment => ({
    id: signals.id,
    verdict,
    ...(score !== undefined && { score: Math.round(score) }),
    confidence,
    reasons,
    unknowns,
    advice,
    warnings,
  });

  if (!signals.found) {
    return result(
      'unknown',
      undefined,
      'low',
      [],
      ['not found in the public npm registry (private, unpublished or very new?)'],
    );
  }

  // 1. The author's word beats any measurement.
  if (signals.latestDeprecated !== undefined) {
    return result('deprecated', 0, 'high', [
      `deprecated: "${summarize(signals.latestDeprecated)}"`,
    ]);
  }
  if (signals.installedDeprecated !== undefined) {
    return result(
      'deprecated',
      40,
      'high',
      [`version ${signals.version} is deprecated: "${summarize(signals.installedDeprecated)}"`],
      [],
      signals.latestVersion ? [`upgrade to ${signals.latestVersion}`] : [],
    );
  }

  const repository = signals.repository;
  const commits = repository?.commitsLast90Days;
  const issues = repository?.openIssues;
  const monthsSinceRelease =
    signals.lastPublishedAt === undefined
      ? undefined
      : (now - Date.parse(signals.lastPublishedAt)) / MONTH_MS;

  const unknowns: string[] = [];
  if (!repository) unknowns.push('no source repository found');
  else if (commits === undefined) unknowns.push('repository activity (no OpenSSF Scorecard data)');
  if (repository && issues === undefined) unknowns.push('open issue count');
  const confidence: Confidence = !repository ? 'low' : commits === undefined ? 'medium' : 'high';

  const archived = repository?.archived === true;
  const share = repository?.topCommitterShare ?? 0;
  const sampled = repository?.sampledCommits ?? 0;
  if (!archived && sampled >= t.singleMaintainerMinCommits && share >= t.singleMaintainerShare) {
    warnings.push({
      code: 'single-maintainer',
      message: `one person wrote ${Math.round(share * 100)}% of the last ${sampled} commits`,
    });
  }

  // 2. Any sign of life.
  const releasedRecently =
    monthsSinceRelease !== undefined && monthsSinceRelease <= t.activeWithinMonths;
  if (releasedRecently || (commits ?? 0) > 0) {
    const reasons: string[] = [];
    if (releasedRecently) reasons.push(`last release ${formatAge(monthsSinceRelease)} ago`);
    if (commits) reasons.push(`${plural(commits, 'commit')} in the last 90 days`);
    const freshness = Math.min(monthsSinceRelease ?? t.activeWithinMonths, t.activeWithinMonths);
    if (archived) {
      warnings.push({
        code: 'archived',
        message: 'repository is archived: no further fixes are expected',
      });
    }
    return result(
      'active',
      100 - (freshness / t.activeWithinMonths) * 10,
      confidence,
      reasons,
      unknowns,
    );
  }

  // 3. Inactive: finished, stale or abandoned.
  const reasons: string[] = [
    monthsSinceRelease === undefined
      ? 'no release dates known'
      : `no release in ${formatAge(monthsSinceRelease)}`,
  ];
  if (commits === 0) reasons.push('no commits in the last 90 days');

  const downloads = signals.weeklyDownloads;
  const unmetDemand =
    issues !== undefined &&
    issues >= t.unmetDemandMinIssues &&
    (!downloads || issues / (downloads / 1e6) >= t.unmetDemandIssuesPerMillionDownloads);

  const size = describeSize(signals, t);
  if (size === undefined) unknowns.push('package size');

  const months = monthsSinceRelease ?? Infinity;
  // An archived repository is read-only: the maintainers have said no more changes are coming.
  // For a small package that can simply mean it is done.
  if (unmetDemand || (archived && !size?.small)) {
    if (unmetDemand) {
      // "Unanswered" only when Scorecard saw no issue activity at all.
      const unanswered = repository?.issueActivityLast90Days === 0 ? ', unanswered' : '';
      reasons.push(`${plural(issues, 'open issue')}${unanswered}${downloadsNote(downloads)}`);
    }
    if (archived) reasons.push('repository is archived (read-only)');
    if (size && !size.small) reasons.push(size.text);
    if (months >= t.abandonedAfterMonths) {
      const yearsOver = (Math.min(months, 240) - t.abandonedAfterMonths) / 12;
      return result('abandoned', Math.max(5, 25 - yearsOver * 3), confidence, reasons, unknowns);
    }
    return result('stale', 45, confidence, reasons, unknowns);
  }

  if (size?.small) {
    reasons.push(size.text);
    if (archived) reasons.push('repository is archived (read-only)');
    if (issues !== undefined) {
      reasons.push(`${plural(issues, 'open issue')}${downloadsNote(downloads)}`);
    }
    return result('finished', 85, confidence, reasons, unknowns);
  }

  if (size) reasons.push(size.text);
  const monthsOver = Math.min(months, 240) - t.activeWithinMonths;
  return result('stale', Math.max(35, 60 - monthsOver / 2), confidence, reasons, unknowns);
}

function describeSize(
  signals: PackageSignals,
  t: Thresholds,
): { small: boolean; text: string } | undefined {
  if (signals.unpackedSize !== undefined) {
    const small = signals.unpackedSize <= t.smallUnpackedBytes;
    const text = `${formatBytes(signals.unpackedSize)} of code`;
    return { small, text: small ? `small package (${text})` : text };
  }
  if (signals.tarballSize !== undefined) {
    const small = signals.tarballSize <= t.smallTarballBytes;
    const text = `${formatBytes(signals.tarballSize)} compressed`;
    return { small, text: small ? `small package (${text})` : text };
  }
  return undefined;
}

/** Deprecation messages can be long and multi-line; reasons need one short line. */
function summarize(message: string, maxLength = 140): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1).trimEnd()}…`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function downloadsNote(downloads: number | undefined): string {
  return downloads ? ` for ${formatCount(downloads)} weekly downloads` : '';
}

export function formatAge(months: number): string {
  if (months < 1) return 'less than a month';
  if (months < 24) {
    const whole = Math.floor(months);
    return whole === 1 ? '1 month' : `${whole} months`;
  }
  return `${Math.floor(months / 12)} years`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCount(count: number): string {
  if (count >= 1e6) return `${Math.round(count / 1e6)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}k`;
  return String(count);
}
