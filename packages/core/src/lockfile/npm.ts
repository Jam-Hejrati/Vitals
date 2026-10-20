import {
  packageId,
  type DependencyGraph,
  type DependencyType,
  type DirectDependency,
  type PackageNode,
} from '../graph.js';
import { LockfileError } from './errors.js';

/** One entry of the `packages` map in package-lock.json (lockfileVersion 2 and 3). */
interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const NODE_MODULES = 'node_modules/';

/** Parses an npm `package-lock.json` (lockfileVersion 2 or 3) into a dependency graph. */
export function parseNpmLockfile(content: string): DependencyGraph {
  let lock: { name?: string; version?: string; packages?: Record<string, LockEntry> };
  try {
    lock = JSON.parse(content);
  } catch (error) {
    throw new LockfileError('package-lock.json is not valid JSON', { cause: error });
  }
  if (typeof lock !== 'object' || lock === null || typeof lock.packages !== 'object') {
    throw new LockfileError(
      'Unsupported package-lock.json: lockfileVersion 2 or 3 is required. ' +
        'Run `npm install` with npm 7 or newer to upgrade it.',
    );
  }

  const entries = lock.packages;
  const rootEntry = entries[''] ?? {};

  // Follow workspace links to the directory they point at.
  const followLink = (location: string): string => {
    const entry = entries[location];
    return entry?.link && entry.resolved !== undefined ? entry.resolved : location;
  };

  // Node's module resolution: look in ./node_modules, then each ancestor's node_modules.
  const resolve = (from: string, name: string): string | undefined => {
    for (let base = from; ; base = parentLocation(base)) {
      const candidate = base === '' ? NODE_MODULES + name : `${base}/${NODE_MODULES}${name}`;
      if (entries[candidate]) return followLink(candidate);
      if (base === '') return undefined;
    }
  };

  const idByLocation = new Map<string, string>();
  const packages = new Map<string, PackageNode>();

  for (const [location, entry] of Object.entries(entries)) {
    if (location === '' || entry.link) continue;
    const name = nameAtLocation(location, entry);
    const version = entry.version ?? '0.0.0';
    const id = packageId(name, version);
    idByLocation.set(location, id);

    const existing = packages.get(id);
    if (existing) {
      // A package is dev/optional only if every installed copy is.
      existing.dev &&= entry.dev === true;
      existing.optional &&= entry.optional === true;
    } else {
      packages.set(id, {
        id,
        name,
        version,
        dev: entry.dev === true,
        optional: entry.optional === true,
        dependencies: [],
      });
    }
  }

  const resolveId = (from: string, name: string): string | undefined => {
    const location = resolve(from, name);
    return location === undefined ? undefined : idByLocation.get(location);
  };

  for (const [location, entry] of Object.entries(entries)) {
    const id = idByLocation.get(location);
    if (id === undefined) continue;
    const node = packages.get(id)!;
    for (const name of dependencyNames(entry, [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ])) {
      const depId = resolveId(location, name);
      if (depId !== undefined && depId !== id && !node.dependencies.includes(depId)) {
        node.dependencies.push(depId);
      }
    }
  }

  const directDependencies: DirectDependency[] = [];
  const seenDirect = new Set<string>();
  const directFields: [keyof LockEntry, DependencyType][] = [
    ['dependencies', 'prod'],
    ['devDependencies', 'dev'],
    ['optionalDependencies', 'optional'],
    ['peerDependencies', 'peer'],
  ];
  for (const [field, type] of directFields) {
    for (const name of dependencyNames(rootEntry, [field])) {
      const id = resolveId('', name);
      if (id !== undefined && !seenDirect.has(id)) {
        seenDirect.add(id);
        directDependencies.push({ id, type });
      }
    }
  }

  return {
    root: {
      name: rootEntry.name ?? lock.name ?? 'root',
      version: rootEntry.version ?? lock.version ?? '0.0.0',
    },
    directDependencies,
    packages,
  };
}

function parentLocation(location: string): string {
  const index = location.lastIndexOf('/' + NODE_MODULES);
  return index === -1 ? '' : location.slice(0, index);
}

function nameAtLocation(location: string, entry: LockEntry): string {
  const index = location.lastIndexOf(NODE_MODULES);
  if (index === -1) return entry.name ?? location; // workspace package directory
  return location.slice(index + NODE_MODULES.length);
}

function dependencyNames(entry: LockEntry, fields: (keyof LockEntry)[]): string[] {
  const names: string[] = [];
  for (const field of fields) {
    const deps = entry[field];
    if (deps && typeof deps === 'object') names.push(...Object.keys(deps));
  }
  return names;
}
