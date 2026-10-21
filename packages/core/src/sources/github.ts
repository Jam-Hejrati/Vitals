import { cached, type Cache } from './cache.js';
import { mapLimit, progressOf, type OnProgress } from './concurrency.js';
import { HttpError, type HttpClient } from './http.js';

const API_URL = 'https://api.github.com';
const PREFIX = 'github.com/';
const CONCURRENCY = 8;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface GitHubRepository {
  archived: boolean;
  /** People who authored commits in the sample below, bots excluded. */
  committers?: number;
  /** Share of the sampled commits written by the most active person, 0–1. */
  topCommitterShare?: number;
  /** The most recent commits of the last year (up to 100) that the figures above are based on. */
  sampledCommits?: number;
}

interface RawCommit {
  author?: { login?: string; type?: string } | null;
  commit?: { author?: { name?: string; email?: string } | null };
}

/**
 * The parts of the GitHub REST API Vitals needs, for repositories found through deps.dev.
 *
 * Optional enrichment: when GitHub fails or rate-limits us, the repositories left over come back
 * as `null` (and are not cached). An invalid token is the one thing that is reported as an error.
 */
export class GitHubClient {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: Cache,
    private readonly token: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keyed by deps.dev project id (`github.com/owner/repo`); other hosts are ignored. */
  getRepositories(
    ids: string[],
    onProgress?: OnProgress,
  ): Promise<Map<string, GitHubRepository | null>> {
    const supported = ids.filter((id) => id.startsWith(PREFIX));
    return cached(this.cache, 'github-repo', supported, async (missing) => {
      const results = new Map<string, GitHubRepository | undefined>();
      let exhausted = false;
      await mapLimit(
        missing,
        CONCURRENCY,
        async (id) => {
          if (exhausted) {
            results.set(id, undefined);
            return;
          }
          try {
            const repository = await this.fetchRepository(id.slice(PREFIX.length));
            if (repository) results.set(id, repository);
          } catch (error) {
            if (error instanceof HttpError && error.status === 401) {
              throw new Error('GitHub rejected the token (HTTP 401). Check GITHUB_TOKEN.', {
                cause: error,
              });
            }
            // Rate limited (403/429) or unreachable: skip the rest and try again next run.
            exhausted = true;
            results.set(id, undefined);
          }
        },
        progressOf(supported, missing, onProgress),
      );
      return results;
    });
  }

  private async fetchRepository(path: string): Promise<GitHubRepository | undefined> {
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
    };
    const repository = await this.http.getJson<{ archived?: boolean }>(
      `${API_URL}/repos/${path}`,
      headers,
    );
    if (!repository) return undefined;
    if (repository.archived) return { archived: true };

    const since = new Date(this.now() - YEAR_MS).toISOString();
    const commits =
      (await this.http.getJson<RawCommit[]>(
        `${API_URL}/repos/${path}/commits?since=${encodeURIComponent(since)}&per_page=100`,
        headers,
      )) ?? [];
    return { archived: false, ...authorship(commits) };
  }
}

function authorship(commits: RawCommit[]): Omit<GitHubRepository, 'archived'> {
  const counts = new Map<string, number>();
  for (const commit of commits) {
    if (commit.author?.type === 'Bot' || commit.author?.login?.endsWith('[bot]')) continue;
    const author =
      commit.author?.login ?? commit.commit?.author?.email ?? commit.commit?.author?.name;
    if (author) counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return {};
  return {
    committers: counts.size,
    topCommitterShare: Math.max(...counts.values()) / total,
    sampledCommits: total,
  };
}
