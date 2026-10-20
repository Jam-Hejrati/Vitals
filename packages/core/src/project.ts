import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DependencyGraph } from './graph.js';
import { LockfileError } from './lockfile/errors.js';
import { parseNpmLockfile } from './lockfile/npm.js';
import { parsePnpmLockfile } from './lockfile/pnpm.js';

export type LockfileKind = 'npm' | 'pnpm';

export interface Project {
  /** Absolute path of the lockfile that was read. */
  lockfile: string;
  kind: LockfileKind;
  graph: DependencyGraph;
}

export const LOCKFILES: Record<LockfileKind, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
};

/** Parses lockfile `content` of the given kind. `root` names the project where the lockfile cannot. */
export function parseLockfile(
  kind: LockfileKind,
  content: string,
  root?: DependencyGraph['root'],
): DependencyGraph {
  return kind === 'npm' ? parseNpmLockfile(content) : parsePnpmLockfile(content, root);
}

const UNSUPPORTED_LOCKFILES = ['yarn.lock', 'bun.lock', 'bun.lockb'];

/** Finds the project's lockfile in `dir` and reads it into a dependency graph. */
export async function loadProject(dir: string): Promise<Project> {
  const manifest = await readJson(join(dir, 'package.json'));

  const found: { kind: LockfileKind; path: string; modified: number }[] = [];
  for (const [kind, file] of Object.entries(LOCKFILES) as [LockfileKind, string][]) {
    const path = join(dir, file);
    const modified = await modifiedTime(path);
    if (modified !== undefined) found.push({ kind, path, modified });
  }

  if (found.length === 0) {
    for (const file of UNSUPPORTED_LOCKFILES) {
      if ((await modifiedTime(join(dir, file))) !== undefined) {
        throw new LockfileError(
          `${file} is not supported yet. Vitals currently reads package-lock.json and pnpm-lock.yaml.`,
        );
      }
    }
    throw new LockfileError(
      `No lockfile found in ${dir}. Vitals reads package-lock.json and pnpm-lock.yaml; ` +
        'run your package manager’s install first.',
    );
  }

  // With both lockfiles present, trust the declared package manager, then the newest file.
  const declared = String(manifest?.packageManager ?? '').split('@')[0];
  const chosen =
    found.find((lockfile) => lockfile.kind === declared) ??
    found.toSorted((a, b) => b.modified - a.modified)[0]!;

  const content = await readFile(chosen.path, 'utf8');
  const graph = parseLockfile(chosen.kind, content, {
    name: typeof manifest?.name === 'string' ? manifest.name : 'root',
    version: typeof manifest?.version === 'string' ? manifest.version : '0.0.0',
  });

  return { lockfile: chosen.path, kind: chosen.kind, graph };
}

async function modifiedTime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
