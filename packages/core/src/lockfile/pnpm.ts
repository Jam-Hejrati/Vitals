import { posix } from 'node:path';
import { parse } from 'yaml';
import {
  packageId,
  reachableFrom,
  type DependencyGraph,
  type DependencyType,
  type DirectDependency,
  type PackageNode,
} from '../graph.js';
import { LockfileError } from './errors.js';

/** `name -> { specifier, version }` as written under each importer. */
type ImporterDependencies = Record<string, { specifier?: string; version: string }>;

interface Importer {
  dependencies?: ImporterDependencies;
  devDependencies?: ImporterDependencies;
  optionalDependencies?: ImporterDependencies;
}

interface Snapshot {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  optional?: boolean;
}

interface PnpmLock {
  lockfileVersion?: string | number;
  importers?: Record<string, Importer>;
  snapshots?: Record<string, Snapshot>;
}

const IMPORTER_FIELDS: [keyof Importer, DependencyType][] = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
];

/**
 * Parses a `pnpm-lock.yaml` (lockfileVersion 9, written by pnpm 9 and newer) into a dependency graph.
 *
 * pnpm lockfiles do not record the project's own name, so callers pass it in `root`.
 */
export function parsePnpmLockfile(
  content: string,
  root: DependencyGraph['root'] = { name: 'root', version: '0.0.0' },
): DependencyGraph {
  let lock: PnpmLock | null;
  try {
    lock = parse(content) as PnpmLock | null;
  } catch (error) {
    throw new LockfileError('pnpm-lock.yaml is not valid YAML', { cause: error });
  }
  const version = String(lock?.lockfileVersion ?? 'unknown');
  if (lock === null || typeof lock !== 'object' || Number.parseInt(version, 10) !== 9) {
    throw new LockfileError(
      `Unsupported pnpm-lock.yaml (lockfileVersion ${version}): lockfileVersion 9 is required. ` +
        'Run `pnpm install` with pnpm 9 or newer to upgrade it.',
    );
  }

  const importers = lock.importers ?? {};
  const snapshots = lock.snapshots ?? {};
  const packages = new Map<string, PackageNode>();
  const idBySnapshot = new Map<string, string>();

  for (const [key, snapshot] of Object.entries(snapshots)) {
    const { name, version } = parseSnapshotKey(key);
    const id = packageId(name, version);
    idBySnapshot.set(key, id);

    // The same version installed with different peers has one snapshot per peer set.
    const existing = packages.get(id);
    if (existing) {
      existing.optional &&= snapshot.optional === true;
    } else {
      packages.set(id, {
        id,
        name,
        version,
        dev: false,
        optional: snapshot.optional === true,
        local: version.startsWith('file:'),
        dependencies: [],
      });
    }
  }

  // Workspace packages appear only as `link:` references; their dependencies are their importer's.
  const linkTargets = new Map<string, string>();

  /** Resolves a dependency as written in the lockfile (`1.0.0(peer@1)`, `alias@1.0.0`, `link:...`). */
  const resolve = (fromDir: string, name: string, reference: string): string | undefined => {
    if (reference.startsWith('link:')) {
      const target = posix.normalize(posix.join(fromDir, reference.slice('link:'.length)));
      const id = packageId(name, `link:${target}`);
      if (!packages.has(id)) {
        packages.set(id, {
          id,
          name,
          version: `link:${target}`,
          dev: false,
          optional: false,
          local: true,
          dependencies: [],
        });
        linkTargets.set(id, target);
      }
      return id;
    }
    // A plain version is keyed `name@version`; an npm alias already is `realName@version`.
    return idBySnapshot.get(`${name}@${reference}`) ?? idBySnapshot.get(reference);
  };

  const addEdge = (node: PackageNode, depId: string | undefined) => {
    if (depId !== undefined && depId !== node.id && !node.dependencies.includes(depId)) {
      node.dependencies.push(depId);
    }
  };

  for (const [key, snapshot] of Object.entries(snapshots)) {
    const node = packages.get(idBySnapshot.get(key)!)!;
    for (const deps of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [name, reference] of Object.entries(deps ?? {})) {
        addEdge(node, resolve('.', name, reference));
      }
    }
  }

  const directDependencies: DirectDependency[] = [];
  for (const [importer, declared] of Object.entries(importers)) {
    const seen = new Set<string>();
    for (const [field, type] of IMPORTER_FIELDS) {
      for (const [name, { version: reference }] of Object.entries(declared[field] ?? {})) {
        const id = resolve(importer, name, reference);
        if (id !== undefined && !seen.has(id)) {
          seen.add(id);
          directDependencies.push({ id, type, importer });
        }
      }
    }
  }

  for (const [id, target] of linkTargets) {
    const node = packages.get(id)!;
    for (const direct of directDependencies) {
      if (direct.importer === target && direct.type !== 'dev') addEdge(node, direct.id);
    }
  }

  const graph: DependencyGraph = { root, directDependencies, packages };

  // pnpm 9 lockfiles have no dev flags: a package is dev-only if production code cannot reach it.
  const production = reachableFrom(
    graph,
    directDependencies.filter((d) => d.type !== 'dev').map((d) => d.id),
  );
  for (const node of packages.values()) node.dev = !production.has(node.id);

  return graph;
}

/** Splits a snapshot key like `@scope/pkg@1.0.0(react@18.2.0)` into name and version. */
function parseSnapshotKey(key: string): { name: string; version: string } {
  const peerSuffix = key.indexOf('(');
  const bare = peerSuffix === -1 ? key : key.slice(0, peerSuffix);
  const separator = bare.indexOf('@', 1);
  if (separator === -1) throw new LockfileError(`Unexpected pnpm-lock.yaml entry: ${key}`);
  return { name: bare.slice(0, separator), version: bare.slice(separator + 1) };
}
