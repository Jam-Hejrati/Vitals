export {
  findDependencyPaths,
  packageId,
  reachableFrom,
  type DependencyGraph,
  type DependencyType,
  type DirectDependency,
  type PackageNode,
} from './graph.js';
export { LockfileError } from './lockfile/errors.js';
export { parseNpmLockfile } from './lockfile/npm.js';
export { parsePnpmLockfile } from './lockfile/pnpm.js';
export {
  LOCKFILES,
  loadProject,
  parseLockfile,
  type LockfileKind,
  type Project,
} from './project.js';
export {
  evaluateCi,
  FAIL_LEVELS,
  packageNames,
  type CiOptions,
  type CiResult,
  type FailLevel,
} from './ci.js';
export { findReplacements, type Suggestion } from './replacements.js';
export {
  analyzeProject,
  buildReport,
  REPORT_SCHEMA_VERSION,
  type AnalyzeOptions,
  type PackageReport,
  type Report,
} from './report.js';
export {
  assess,
  DEFAULT_THRESHOLDS,
  formatAge,
  formatBytes,
  formatCount,
  type Assessment,
  type AssessOptions,
  type Confidence,
  type Thresholds,
  type Verdict,
  type Warning,
} from './scoring.js';
export {
  collectSignals,
  type CollectSignalsOptions,
  type PackageSignals,
  type RepositorySignals,
} from './signals.js';
export { defaultCacheDir, FileCache, MemoryCache, type Cache } from './sources/cache.js';
export { HttpClient, HttpError, type FetchLike, type HttpClientOptions } from './sources/http.js';
