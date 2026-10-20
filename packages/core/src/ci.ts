import type { DependencyGraph } from './graph.js';
import type { PackageReport, Report } from './report.js';

/** The least severe verdict that fails the check. Each level includes the ones before it. */
export type FailLevel = 'deprecated' | 'abandoned' | 'stale';

export const FAIL_LEVELS: readonly FailLevel[] = ['deprecated', 'abandoned', 'stale'];

export interface CiOptions {
  failOn: FailLevel;
  /** The git ref the project was compared with. Only recorded in the result. */
  base?: string;
  /** Names of the packages that already existed. Without them, every package counts as new. */
  baseNames?: ReadonlySet<string>;
}

export interface CiResult {
  failOn: FailLevel;
  base?: string;
  /** Packages that were not in the base (every package when there is no base). */
  newPackages: number;
  /** New packages whose verdict is at or beyond `failOn`: the reason the check fails. */
  offenders: PackageReport[];
  /** New packages with a problem that does not reach `failOn`: worth a look, but not failing. */
  watch: PackageReport[];
  passed: boolean;
}

/** Decides whether newly added dependencies are healthy enough, given a finished report. */
export function evaluateCi(report: Report, options: CiOptions): CiResult {
  const { failOn, base, baseNames } = options;
  const limit = FAIL_LEVELS.indexOf(failOn);

  const added = report.packages.filter((pkg) => !baseNames?.has(pkg.name));
  const offenders: PackageReport[] = [];
  const watch: PackageReport[] = [];
  for (const pkg of added) {
    const severity = FAIL_LEVELS.indexOf(pkg.verdict as FailLevel);
    if (severity === -1) continue;
    (severity <= limit ? offenders : watch).push(pkg);
  }

  return {
    failOn,
    ...(base !== undefined && { base }),
    newPackages: added.length,
    offenders,
    watch,
    passed: offenders.length === 0,
  };
}

/** Names of the registry packages in a graph, ignoring local workspace packages. */
export function packageNames(graph: DependencyGraph): Set<string> {
  return new Set([...graph.packages.values()].filter((pkg) => !pkg.local).map((pkg) => pkg.name));
}
