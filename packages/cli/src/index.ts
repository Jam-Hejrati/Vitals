#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeProject, LockfileError, loadProject } from '@vitals/core';
import { formatReport } from './format.js';

const HELP = `Usage: vitals [directory] [options]

Check whether a project's dependencies are alive, finished, or dying.

With a GITHUB_TOKEN (or GH_TOKEN) in the environment, Vitals also checks archived
repositories and finds dependencies that are maintained by a single person.

Options:
  --all          List healthy packages too, not just the ones that need attention
  --prod         Ignore packages that are only used for development
  --json         Print the full report as JSON
  --no-github    Do not use the GitHub API even if GITHUB_TOKEN is set
  --no-color     Disable colors (also set by NO_COLOR)
  -h, --help     Show this help
  -v, --version  Show the version
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      prod: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-github': { type: 'boolean' },
      'no-color': { type: 'boolean' },
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

  const project = await loadProject(resolve(positionals[0] ?? '.'));

  const interactive = process.stderr.isTTY && !values.json;
  if (interactive) process.stderr.write('Checking dependencies…');
  const githubToken = values['no-github']
    ? undefined
    : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
  const report = await analyzeProject(project, {
    production: values.prod === true,
    ...(githubToken && { githubToken }),
  });
  if (interactive) process.stderr.write('\r\x1b[K');

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }
  const color = !values['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY === true;
  process.stdout.write(
    formatReport(report, { all: values.all === true, color, github: githubToken !== undefined }),
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
