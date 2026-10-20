import { cached, type Cache } from './cache.js';
import { chunk, mapLimit } from './concurrency.js';
import type { HttpClient } from './http.js';

const BASE_URL = 'https://api.deps.dev';
const BATCH_SIZE = 1000;
const CONCURRENCY = 16;

export interface DepsDevVersion {
  version: string;
  publishedAt?: string;
  isDefault?: boolean;
  deprecatedReason?: string;
}

export interface DepsDevPackage {
  name: string;
  versions: DepsDevVersion[];
}

export interface DepsDevVersionDetails {
  licenses: string[];
  /** Project id of the source repository, e.g. `github.com/moment/moment`. */
  sourceRepository?: string;
}

export interface ScorecardCheck {
  name: string;
  score: number;
  reason: string;
}

export interface DepsDevProject {
  id: string;
  openIssuesCount?: number;
  starsCount?: number;
  forksCount?: number;
  scorecard?: { date: string; overallScore: number; checks: ScorecardCheck[] };
}

/** Client for the deps.dev API (https://docs.deps.dev/api/v3/). Only npm for now. */
export class DepsDevClient {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: Cache,
  ) {}

  /** All published versions of each package. */
  getPackages(names: string[]): Promise<Map<string, DepsDevPackage | null>> {
    return cached(this.cache, 'depsdev-package', names, async (missing) => {
      const packages = await mapLimit(missing, CONCURRENCY, (name) => this.fetchPackage(name));
      return new Map(packages.flatMap((pkg) => (pkg ? [[pkg.name, pkg]] : [])));
    });
  }

  /** Licenses and source repository of specific versions, keyed by `name@version`. */
  getVersionDetails(
    versions: { name: string; version: string }[],
  ): Promise<Map<string, DepsDevVersionDetails | null>> {
    const byKey = new Map(versions.map((v) => [`${v.name}@${v.version}`, v]));
    return cached(this.cache, 'depsdev-version', [...byKey.keys()], async (missing) => {
      const requests = missing.map((key) => {
        const { name, version } = byKey.get(key)!;
        return { versionKey: { system: 'NPM', name, version } };
      });
      const results = new Map<string, DepsDevVersionDetails>();
      for (const response of await this.batch<RawVersionResponse>('versionbatch', requests)) {
        const raw = response.version;
        if (!raw) continue;
        results.set(`${raw.versionKey.name}@${raw.versionKey.version}`, toVersionDetails(raw));
      }
      return results;
    });
  }

  /** Repository statistics and OpenSSF Scorecard results, keyed by project id. */
  getProjects(ids: string[]): Promise<Map<string, DepsDevProject | null>> {
    return cached(this.cache, 'depsdev-project', ids, async (missing) => {
      const requests = missing.map((id) => ({ projectKey: { id } }));
      const results = new Map<string, DepsDevProject>();
      for (const response of await this.batch<RawProjectResponse>('projectbatch', requests)) {
        // Project ids are case-insensitive; answer under the id that was asked for.
        const id = response.request.projectKey.id;
        if (response.project) results.set(id, toProject(id, response.project));
      }
      return results;
    });
  }

  private async fetchPackage(name: string): Promise<DepsDevPackage | undefined> {
    const raw = await this.http.getJson<RawPackage>(
      `${BASE_URL}/v3/systems/npm/packages/${encodeURIComponent(name)}`,
    );
    if (!raw) return undefined;
    return {
      name,
      versions: raw.versions.map((v) => ({
        version: v.versionKey.version,
        ...(v.publishedAt && { publishedAt: v.publishedAt }),
        ...(v.isDefault && { isDefault: true }),
        ...(v.isDeprecated && { deprecatedReason: v.deprecatedReason || 'deprecated' }),
      })),
    };
  }

  private async batch<R>(endpoint: string, requests: unknown[]): Promise<R[]> {
    const responses: R[] = [];
    for (const requestChunk of chunk(requests, BATCH_SIZE)) {
      let pageToken: string | undefined;
      do {
        const page: { responses?: R[]; nextPageToken?: string } = await this.http.postJson(
          `${BASE_URL}/v3alpha/${endpoint}`,
          { requests: requestChunk, ...(pageToken && { pageToken }) },
        );
        responses.push(...(page.responses ?? []));
        pageToken = page.nextPageToken || undefined;
      } while (pageToken);
    }
    return responses;
  }
}

interface RawPackage {
  versions: {
    versionKey: { version: string };
    publishedAt?: string;
    isDefault?: boolean;
    isDeprecated?: boolean;
    deprecatedReason?: string;
  }[];
}

interface RawVersionResponse {
  version?: {
    versionKey: { name: string; version: string };
    licenses?: string[];
    relatedProjects?: { projectKey: { id: string }; relationType: string }[];
  };
}

interface RawProjectResponse {
  request: { projectKey: { id: string } };
  project?: {
    openIssuesCount?: number;
    starsCount?: number;
    forksCount?: number;
    scorecard?: {
      date: string;
      overallScore: number;
      checks: { name: string; score: number; reason?: string }[];
    };
  };
}

function toVersionDetails(raw: NonNullable<RawVersionResponse['version']>): DepsDevVersionDetails {
  const repository = raw.relatedProjects?.find((p) => p.relationType === 'SOURCE_REPO');
  return {
    licenses: raw.licenses ?? [],
    ...(repository && { sourceRepository: repository.projectKey.id }),
  };
}

function toProject(id: string, raw: NonNullable<RawProjectResponse['project']>): DepsDevProject {
  return {
    id,
    ...(raw.openIssuesCount !== undefined && { openIssuesCount: raw.openIssuesCount }),
    ...(raw.starsCount !== undefined && { starsCount: raw.starsCount }),
    ...(raw.forksCount !== undefined && { forksCount: raw.forksCount }),
    ...(raw.scorecard && {
      scorecard: {
        date: raw.scorecard.date,
        overallScore: raw.scorecard.overallScore,
        // Keep only what scoring needs; the full details are large.
        checks: raw.scorecard.checks.map((c) => ({
          name: c.name,
          score: c.score,
          reason: c.reason ?? '',
        })),
      },
    }),
  };
}
