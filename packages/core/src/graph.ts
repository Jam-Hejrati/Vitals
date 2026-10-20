export type DependencyType = 'prod' | 'dev' | 'optional' | 'peer';

/** A package at a specific version. Copies installed at several locations collapse into one node. */
export interface PackageNode {
  /** `name@version` */
  id: string;
  name: string;
  version: string;
  /** Only reachable through devDependencies. */
  dev: boolean;
  /** Only reachable through optionalDependencies. */
  optional: boolean;
  /** Lives in the project itself (workspace package or `file:`/`link:` dependency); never scored. */
  local: boolean;
  /** Ids of the packages this one depends on. */
  dependencies: string[];
}

export interface DirectDependency {
  id: string;
  type: DependencyType;
  /** Project directory that declares it, relative to the root: `.` or a workspace path. */
  importer: string;
}

export interface DependencyGraph {
  root: { name: string; version: string };
  directDependencies: DirectDependency[];
  packages: Map<string, PackageNode>;
}

export function packageId(name: string, version: string): string {
  return `${name}@${version}`;
}

/** Ids of every package reachable from `startIds`, including the start packages themselves. */
export function reachableFrom(graph: DependencyGraph, startIds: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(graph.packages.get(id)?.dependencies ?? []));
  }
  return seen;
}

/**
 * Answers "why is this here?": the dependency chains from direct dependencies down to `targetId`.
 *
 * Returns the shortest chain for each direct dependency that leads to the target, shortest first.
 * Each chain starts with a direct dependency and ends with the target.
 */
export function findDependencyPaths(graph: DependencyGraph, targetId: string): string[][] {
  if (!graph.packages.has(targetId)) return [];

  const dependents = new Map<string, string[]>();
  for (const pkg of graph.packages.values()) {
    for (const dep of pkg.dependencies) {
      const list = dependents.get(dep);
      if (list) list.push(pkg.id);
      else dependents.set(dep, [pkg.id]);
    }
  }
  const direct = new Set(graph.directDependencies.map((d) => d.id));

  // Breadth-first search upward from the target; `next` points one step back toward the target.
  const next = new Map<string, string | null>([[targetId, null]]);
  const queue = [targetId];
  const paths: string[][] = [];

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    if (direct.has(id)) {
      const path: string[] = [];
      for (let hop: string | null = id; hop !== null; hop = next.get(hop) ?? null) path.push(hop);
      paths.push(path);
    }
    for (const parent of dependents.get(id) ?? []) {
      if (!next.has(parent)) {
        next.set(parent, id);
        queue.push(parent);
      }
    }
  }

  return paths;
}
