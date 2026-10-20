#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LockfileError, parseNpmLockfile } from '@vitals/core';

const HELP = `Usage: vitals [directory] [options]

Check the maintenance health of a project's dependencies.

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const lockfilePath = resolve(positionals[0] ?? '.', 'package-lock.json');
  let content: string;
  try {
    content = await readFile(lockfilePath, 'utf8');
  } catch {
    process.stderr.write(`No package-lock.json found at ${lockfilePath}\n`);
    return 2;
  }

  const graph = parseNpmLockfile(content);
  process.stdout.write(
    `${graph.root.name}: ${graph.directDependencies.length} direct, ` +
      `${graph.packages.size} total packages.\n` +
      'Health scoring is not implemented yet.\n',
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      error instanceof LockfileError ? `${error.message}\n` : `${String(error)}\n`,
    );
    process.exitCode = error instanceof LockfileError ? 2 : 1;
  },
);
