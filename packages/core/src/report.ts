import { basename } from 'node:path';
import { findDependencyPaths, type DependencyGraph } from './graph.js';
import { findReplacements, type Suggestion } from './replacements.js';
import type { LockfileKind, Project } from './project.js';
import {
  assess,
  type Assessment,
  type AssessOptions,
  type Thresholds,
  type Verdict,
} from './scoring.js';
import { collectSignals, type CollectSignalsOptions, type PackageSignals } from './signals.js';

/** Bumped when the shape of `Report` changes incompatibly, so consumers of `--json` can rely on it. */
export const REPORT_SCHEMA_VERSION = 1;

const MAX_PATHS = 3;

export interface PackageReport extends Assessment {
  name: string;
  version: string;
  /** Declared by the project itself (or one of its workspaces). */
  direct: boolean;
  /** Only reachable through devDependencies. */
  dev: boolean;
  /** Why it is installed: chains from a direct dependency to this package (shortest first). */
  paths: string[][];
  /**
   * Every direct dependency that brings this package in (ids). Removing or replacing the package
   * only helps when this is the single entry, or when all of them go.
   */
  introducedBy: string[];
  /** What the e18e community suggests using instead. Advice only: it never changes the verdict. */
  replacements: Suggestion[];
}

export interface Report {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAt: string;
  project: { name: string; version: string; lockfile: string; packageManager: LockfileKind };
  summary: { total: number; direct: number; verdicts: Record<Verdict, number> };
  /** Worst first: deprecated, abandoned, stale, unknown, finished, active. */
  packages: PackageReport[];
}

export interface AnalyzeOptions extends CollectSignalsOptions {
  thresholds?: Partial<Thresholds>;
  /** Leave out packages that are only reachable through devDependencies. */
  production?: boolean;
}

/** Fetches signals for every package in the project and assesses them. */
export async function analyzeProject(
  project: Project,
  options: AnalyzeOptions = {},
): Promise<Report> {
  const { production, thresholds, ...collect } = options;
  const graph = production ? withoutDevPackages(project.graph) : project.graph;
  const signals = await collectSignals(graph, collect);
  return buildReport({ ...project, graph }, signals, {
    ...(options.now && { now: options.now }),
    ...(thresholds && { thresholds }),
  });
}

/** Assesses collected signals and arranges them into a report. Pure: no network access. */
export function buildReport(
  project: Project,
  signals: Map<string, PackageSignals>,
  options: AssessOptions = {},
): Report {
  const { graph } = project;
  const direct = new Set(graph.directDependencies.map((d) => d.id));
  const verdicts: Record<Verdict, number> = {
    deprecated: 0,
    abandoned: 0,
    stale: 0,
    unknown: 0,
    finished: 0,
    active: 0,
  };

  const packages: PackageReport[] = [];
  for (const entry of signals.values()) {
    const assessment = assess(entry, options);
    verdicts[assessment.verdict]++;
    const chains = findDependencyPaths(graph, entry.id).filter((path) => path.length > 1);
    packages.push({
      ...assessment,
      name: entry.name,
      version: entry.version,
      direct: direct.has(entry.id),
      dev: graph.packages.get(entry.id)?.dev ?? false,
      paths: chains.slice(0, MAX_PATHS),
      introducedBy: chains.map((chain) => chain[0]!),
      replacements: findReplacements(entry.name),
    });
  }
  packages.sort(byUrgency);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    project: {
      name: graph.root.name,
      version: graph.root.version,
      lockfile: basename(project.lockfile),
      packageManager: project.kind,
    },
    summary: { total: packages.length, direct: packages.filter((p) => p.direct).length, verdicts },
    packages,
  };
}

const URGENCY: Record<Verdict, number> = {
  deprecated: 0,
  abandoned: 1,
  stale: 2,
  unknown: 3,
  finished: 4,
  active: 5,
};

function byUrgency(a: PackageReport, b: PackageReport): number {
  return (
    URGENCY[a.verdict] - URGENCY[b.verdict] ||
    Number(b.direct) - Number(a.direct) ||
    (a.score ?? 101) - (b.score ?? 101) ||
    a.id.localeCompare(b.id)
  );
}

function withoutDevPackages(graph: DependencyGraph): DependencyGraph {
  return {
    ...graph,
    packages: new Map([...graph.packages].filter(([, node]) => !node.dev)),
  };
}
