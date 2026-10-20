import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockfileError, loadProject } from '../src/index.js';

const NPM_LOCK = JSON.stringify({
  name: 'npm-app',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: { '': { name: 'npm-app', version: '1.0.0' } },
});
const PNPM_LOCK = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";

describe('loadProject', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vitals-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (file: string, content: string) => writeFile(join(dir, file), content);

  it('reads package-lock.json', async () => {
    await write('package-lock.json', NPM_LOCK);
    const project = await loadProject(dir);
    expect(project.kind).toBe('npm');
    expect(project.graph.root.name).toBe('npm-app');
  });

  it('reads pnpm-lock.yaml with the name from package.json', async () => {
    await write('package.json', JSON.stringify({ name: 'pnpm-app', version: '2.0.0' }));
    await write('pnpm-lock.yaml', PNPM_LOCK);
    const project = await loadProject(dir);
    expect(project.kind).toBe('pnpm');
    expect(project.graph.root).toEqual({ name: 'pnpm-app', version: '2.0.0' });
  });

  it('prefers the declared package manager when both lockfiles exist', async () => {
    await write('package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
    await write('pnpm-lock.yaml', PNPM_LOCK);
    await write('package-lock.json', NPM_LOCK);
    expect((await loadProject(dir)).kind).toBe('pnpm');
  });

  it('otherwise prefers the newest lockfile', async () => {
    await write('pnpm-lock.yaml', PNPM_LOCK);
    await write('package-lock.json', NPM_LOCK);
    await utimes(join(dir, 'pnpm-lock.yaml'), new Date(2020, 0), new Date(2020, 0));
    expect((await loadProject(dir)).kind).toBe('npm');
  });

  it('names unsupported lockfiles', async () => {
    await write('yarn.lock', '');
    await expect(loadProject(dir)).rejects.toThrow(/yarn\.lock is not supported yet/);
  });

  it('fails clearly without a lockfile', async () => {
    await expect(loadProject(dir)).rejects.toThrow(LockfileError);
  });
});
