import type { DependencyGraph, PackageNode } from './graph.js';
import { defaultCacheDir, FileCache, type Cache } from './sources/cache.js';
import { DepsDevClient, type DepsDevPackage, type DepsDevProject } from './sources/depsdev.js';
import { HttpClient } from './sources/http.js';
import { NpmDownloadsClient } from './sources/npm-downloads.js';
import { NpmRegistryClient } from './sources/npm-registry.js';

/** Raw, unjudged facts about one installed package. Scoring turns these into a verdict. */
export interface PackageSignals {
  id: string;
  name: string;
  version: string;
  /** False when deps.dev has no record of the package (private, unpublished, or brand new). */
  found: boolean;
  installedPublishedAt?: string;
  /** Deprecation message of the installed version. */
  installedDeprecated?: string;
  latestVersion?: string;
  /** Deprecation message of the latest version: the package as a whole is deprecated. */
  latestDeprecated?: string;
  firstPublishedAt?: string;
  lastPublishedAt?: string;
  versionCount: number;
  releasesLastYear: number;
  /** Releases in the last year that are not prereleases (`1.0.0`, not `1.0.0-canary.3`). */
  stableReleasesLastYear: number;
  /** Installed dependencies of this package. */
  dependencyCount: number;
  /**
   * Size of the latest version. Only looked up for packages without a release in the last year,
   * the only ones whose verdict depends on it.
   */
  unpackedSize?: number;
  fileCount?: number;
  /** Compressed size, when the registry did not record `unpackedSize` (versions before ~2018). */
  tarballSize?: number;
  licenses: string[];
  weeklyDownloads?: number;
  repository?: RepositorySignals;
}

export interface RepositorySignals {
  /** e.g. `github.com/moment/moment` */
  id: string;
  openIssues?: number;
  stars?: number;
  forks?: number;
  scorecardScore?: number;
  scorecardDate?: string;
  /** OpenSSF Scorecard "Maintained" check, 0–10. */
  maintainedScore?: number;
  commitsLast90Days?: number;
  issueActivityLast90Days?: number;
}

export interface CollectSignalsOptions {
  http?: HttpClient;
  cache?: Cache;
  now?: Date;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** Fetches signals for every registry package in the graph. Local and git/tarball packages are skipped. */
export async function collectSignals(
  graph: DependencyGraph,
  options: CollectSignalsOptions = {},
): Promise<Map<string, PackageSignals>> {
  const http = options.http ?? new HttpClient();
  const cache = options.cache ?? new FileCache(defaultCacheDir());
  const now = (options.now ?? new Date()).getTime();
  const depsDev = new DepsDevClient(http, cache);
  const downloads = new NpmDownloadsClient(http, cache);
  const registry = new NpmRegistryClient(http, cache);

  const nodes = [...graph.packages.values()].filter(
    (node) => !node.local && REGISTRY_VERSION.test(node.version),
  );
  const names = [...new Set(nodes.map((node) => node.name))];

  const [packages, weeklyDownloads] = await Promise.all([
    depsDev.getPackages(names),
    downloads.getWeeklyDownloads(names),
  ]);

  // Licenses come from the installed version; the repository from the latest, as repos move.
  const versionKeys = new Map<string, { name: string; version: string }>();
  for (const node of nodes) {
    versionKeys.set(node.id, { name: node.name, version: node.version });
    const latest = latestVersion(packages.get(node.name));
    if (latest) versionKeys.set(`${node.name}@${latest}`, { name: node.name, version: latest });
  }
  const details = await depsDev.getVersionDetails([...versionKeys.values()]);

  const repositoryOf = (node: PackageNode): string | undefined => {
    const latest = latestVersion(packages.get(node.name));
    return (
      (latest && details.get(`${node.name}@${latest}`)?.sourceRepository) ??
      details.get(node.id)?.sourceRepository
    );
  };
  const repositoryIds = [...new Set(nodes.map(repositoryOf).filter((id) => id !== undefined))];
  const inactiveNames = names.filter((name) => {
    const last = lastPublishedAt(packages.get(name));
    return last === undefined || now - Date.parse(last) > YEAR_MS;
  });
  const [projects, sizes] = await Promise.all([
    depsDev.getProjects(repositoryIds),
    registry.getLatestSizes(inactiveNames),
  ]);

  const signals = new Map<string, PackageSignals>();
  for (const node of nodes) {
    const pkg = packages.get(node.name) ?? undefined;
    const repositoryId = repositoryOf(node);
    const project = repositoryId === undefined ? undefined : projects.get(repositoryId);
    const size = sizes.get(node.name);
    signals.set(node.id, {
      ...packageSignals(node, pkg, now),
      dependencyCount: node.dependencies.length,
      ...optional('unpackedSize', size?.unpackedSize),
      ...optional('fileCount', size?.fileCount),
      ...optional('tarballSize', size?.tarballSize),
      licenses: details.get(node.id)?.licenses ?? [],
      ...optional('weeklyDownloads', weeklyDownloads.get(node.name)),
      ...(repositoryId && { repository: repositorySignals(repositoryId, project ?? undefined) }),
    });
  }
  return signals;
}

function packageSignals(
  node: PackageNode,
  pkg: DepsDevPackage | undefined,
  now: number,
): Omit<PackageSignals, 'licenses' | 'dependencyCount'> {
  const base = { id: node.id, name: node.name, version: node.version };
  if (!pkg) {
    return {
      ...base,
      found: false,
      versionCount: 0,
      releasesLastYear: 0,
      stableReleasesLastYear: 0,
    };
  }

  const installed = pkg.versions.find((v) => v.version === node.version);
  const latest = pkg.versions.find((v) => v.version === latestVersion(pkg));
  const published = pkg.versions
    .map((v) => v.publishedAt)
    .filter((date) => date !== undefined)
    .sort();
  const withinYear = pkg.versions.filter(
    (v) => v.publishedAt !== undefined && now - Date.parse(v.publishedAt) <= YEAR_MS,
  );

  return {
    ...base,
    found: true,
    ...optional('installedPublishedAt', installed?.publishedAt),
    ...optional('installedDeprecated', installed?.deprecatedReason),
    ...optional('latestVersion', latest?.version),
    ...optional('latestDeprecated', latest?.deprecatedReason),
    ...optional('firstPublishedAt', published[0]),
    ...optional('lastPublishedAt', published.at(-1)),
    versionCount: pkg.versions.length,
    releasesLastYear: withinYear.length,
    stableReleasesLastYear: withinYear.filter((v) => !v.version.includes('-')).length,
  };
}

function repositorySignals(id: string, project: DepsDevProject | undefined): RepositorySignals {
  const maintained = project?.scorecard?.checks.find((check) => check.name === 'Maintained');
  // e.g. "30 commit(s) and 0 issue activity found in the last 90 days -- score normalized to 10"
  const activity = maintained?.reason.match(/(\d+) commit\(s\) and (\d+) issue activity/);
  return {
    id,
    ...optional('openIssues', project?.openIssuesCount),
    ...optional('stars', project?.starsCount),
    ...optional('forks', project?.forksCount),
    ...optional('scorecardScore', project?.scorecard?.overallScore),
    ...optional('scorecardDate', project?.scorecard?.date),
    ...(maintained && maintained.score >= 0 && { maintainedScore: maintained.score }),
    ...(activity && {
      commitsLast90Days: Number(activity[1]),
      issueActivityLast90Days: Number(activity[2]),
    }),
  };
}

function lastPublishedAt(pkg: DepsDevPackage | null | undefined): string | undefined {
  return pkg?.versions
    .map((v) => v.publishedAt)
    .filter((date) => date !== undefined)
    .sort()
    .at(-1);
}

/** The version `npm install <name>` would pick, falling back to the newest published. */
function latestVersion(pkg: DepsDevPackage | null | undefined): string | undefined {
  if (!pkg) return undefined;
  const tagged = pkg.versions.find((v) => v.isDefault);
  if (tagged) return tagged.version;
  return pkg.versions
    .filter((v) => v.publishedAt !== undefined)
    .sort((a, b) => a.publishedAt!.localeCompare(b.publishedAt!))
    .at(-1)?.version;
}

/** `{ [key]: value }` when value is defined, `{}` otherwise — for exactOptionalPropertyTypes. */
function optional<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return value === undefined || value === null ? {} : ({ [key]: value } as { [P in K]?: V });
}
