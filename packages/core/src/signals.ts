import type { DependencyGraph, PackageNode } from './graph.js';
import { defaultCacheDir, FileCache, type Cache } from './sources/cache.js';
import { DepsDevClient, type DepsDevPackage, type DepsDevProject } from './sources/depsdev.js';
import { GitHubClient, type GitHubRepository } from './sources/github.js';
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
   * Size of the latest version. Only looked up for inactive packages (no release in the last year
   * and no recent commits), the only ones whose verdict depends on it.
   */
  unpackedSize?: number;
  fileCount?: number;
  /** Compressed size, when the registry did not record `unpackedSize` (versions before ~2018). */
  tarballSize?: number;
  licenses: string[];
  /** Only looked up for inactive packages, like the size above. */
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
  /** The remaining fields come from the GitHub API and are only present with a token. */
  archived?: boolean;
  /** People who authored commits in the last year (from a sample of up to 100), bots excluded. */
  committers?: number;
  /** Share of those commits written by the most active person, 0–1. */
  topCommitterShare?: number;
  sampledCommits?: number;
}

export interface CollectSignalsOptions {
  http?: HttpClient;
  cache?: Cache;
  now?: Date;
  /**
   * A GitHub token enables the GitHub API for direct dependencies and inactive packages: archived
   * repositories and who actually commits. Without one, those signals are simply absent.
   */
  githubToken?: string;
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

  const packages = await depsDev.getPackages(names);

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
  const projects = await depsDev.getProjects(repositoryIds);

  // Size and download counts only matter for inactive packages: no release in the last year and
  // no recent repository commits. Skipping the rest saves most of the requests.
  const repositoryByName = new Map(nodes.map((node) => [node.name, repositoryOf(node)]));
  const isInactive = (name: string): boolean => {
    const last = lastPublishedAt(packages.get(name));
    if (last !== undefined && now - Date.parse(last) <= YEAR_MS) return false;
    const repositoryId = repositoryByName.get(name);
    if (repositoryId === undefined) return true;
    const commits = repositorySignals(repositoryId, projects.get(repositoryId) ?? undefined);
    return !((commits.commitsLast90Days ?? 0) > 0);
  };
  const inactiveNames = names.filter(isInactive);
  const [sizes, weeklyDownloads] = await Promise.all([
    registry.getLatestSizes(inactiveNames),
    downloads.getWeeklyDownloads(inactiveNames),
  ]);

  let repositories = new Map<string, GitHubRepository | null>();
  if (options.githubToken) {
    const directNames = new Set(
      graph.directDependencies.map((d) => graph.packages.get(d.id)?.name).filter((n) => n),
    );
    const wanted = names
      .filter((name) => directNames.has(name) || inactiveNames.includes(name))
      .map((name) => repositoryByName.get(name))
      .filter((id) => id !== undefined);
    repositories = await new GitHubClient(
      http,
      cache,
      options.githubToken,
      () => now,
    ).getRepositories([...new Set(wanted)]);
  }

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
      ...(repositoryId && {
        repository: repositorySignals(
          repositoryId,
          project ?? undefined,
          repositories.get(repositoryId) ?? undefined,
        ),
      }),
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

function repositorySignals(
  id: string,
  project: DepsDevProject | undefined,
  github?: GitHubRepository,
): RepositorySignals {
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
    ...(github && {
      archived: github.archived,
      ...optional('committers', github.committers),
      ...optional('topCommitterShare', github.topCommitterShare),
      ...optional('sampledCommits', github.sampledCommits),
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
