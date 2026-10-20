import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors.js';
import { readFileAtRef } from '../src/git.js';

describe('readFileAtRef', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    });

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vitals-git-'));
    git('init', '-q');
    await mkdir(join(repo, 'app'));
    await writeFile(join(repo, 'app', 'package-lock.json'), 'first');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    await writeFile(join(repo, 'app', 'package-lock.json'), 'second');
    git('commit', '-q', '-am', 'second');
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('reads the file as committed at a ref, from a subdirectory of the repository', async () => {
    const app = join(repo, 'app');
    expect(await readFileAtRef(app, 'HEAD~1', 'package-lock.json')).toBe('first');
    expect(await readFileAtRef(app, 'HEAD', 'package-lock.json')).toBe('second');
  });

  it('returns undefined when the file did not exist at that ref', async () => {
    expect(await readFileAtRef(join(repo, 'app'), 'HEAD', 'pnpm-lock.yaml')).toBeUndefined();
  });

  it('explains how to fix an unknown ref', async () => {
    const error = await readFileAtRef(repo, 'origin/nope', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('fetch-depth: 0');
  });

  it('refuses refs that look like options', async () => {
    await expect(readFileAtRef(repo, '--output=x', 'x')).rejects.toThrow(/Invalid git ref/);
  });
});
