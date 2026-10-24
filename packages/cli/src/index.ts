#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyzeProject,
  evaluateCi,
  FAIL_LEVELS,
  LOCKFILES,
  LockfileError,
  loadProject,
  packageNames,
  parseLockfile,
  type CiResult,
  type FailLevel,
  type Progress,
  type Report,
} from '@vitals/core';
import { UsageError } from './errors.js';
import { formatCi, formatReport, supportsLinks } from './format.js';
import { readFileAtRef } from './git.js';
import { formatCiMarkdown, formatReportMarkdown } from './markdown.js';
import { ProgressLine } from './progress.js';

const HELP = `Usage: vitals [directory] [options]

Check whether a project's dependencies are alive, finished, or dying.

GitHub token (optional): with GITHUB_TOKEN (or GH_TOKEN) set in the environment, Vitals also
checks archived repositories and finds dependencies maintained by a single person.
  Create one at https://github.com/settings/personal-access-tokens/new (public repositories,
  read-only, no permissions), then set it before running vitals:
    PowerShell:   $env:GITHUB_TOKEN = "your-token"
    bash / zsh:   export GITHUB_TOKEN=your-token
  The token is read from the environment only, never from a flag, so it stays out of your
  shell history.

Options:
  --all                List healthy packages too, not just the ones that need attention
  --prod               Ignore packages that are only used for development
  --json               Print the full report as JSON
  --markdown <file>    Also write the report as Markdown to <file>, for pull request comments
                       and job summaries (- prints it instead of the usual report)
  --no-github          Do not use the GitHub API even if GITHUB_TOKEN is set
  --no-color           Disable colors (also set by NO_COLOR)
  -h, --help           Show this help
  -v, --version        Show the version

For CI (exit code 1 when the check fails, 2 on errors):
  --ci                 Fail when dependencies are deprecated, abandoned or stale
  --base <git-ref>     With --ci, only check packages that are new compared with this ref
                       (default on GitHub pull requests: origin/$GITHUB_BASE_REF)
  --fail-on <level>    deprecated | abandoned | stale  (default: abandoned)
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      prod: { type: 'boolean' },
      json: { type: 'boolean' },
      markdown: { type: 'string' },
      'no-github': { type: 'boolean' },
      'no-color': { type: 'boolean' },
      ci: { type: 'boolean' },
      base: { type: 'string' },
      'fail-on': { type: 'string' },
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
  if ((values.base !== undefined || values['fail-on'] !== undefined) && !values.ci) {
    throw new UsageError('--base and --fail-on only make sense together with --ci.');
  }

  const dir = resolve(positionals[0] ?? '.');
  const project = await loadProject(dir);

  // Resolve the comparison first, so a wrong ref fails fast instead of after the slow part.
  const failOn = parseFailOn(values['fail-on'] ?? 'abandoned');
  const baseRef =
    values.base ??
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);
  let baseNames: Set<string> | undefined;
  if (values.ci && baseRef) {
    const content = await readFileAtRef(dir, baseRef, LOCKFILES[project.kind]);
    baseNames =
      content === undefined ? new Set() : packageNames(parseLockfile(project.kind, content));
  }

  const githubToken = values['no-github']
    ? undefined
    : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
  const noColor = values['no-color'] === true || Boolean(process.env.NO_COLOR);
  if (values.json && values.markdown === '-') {
    throw new UsageError('--json and --markdown - both print to the standard output; pick one.');
  }
  const progress =
    process.stderr.isTTY && !values.json && values.markdown !== '-'
      ? new ProgressLine(process.stderr, { github: githubToken !== undefined, color: !noColor })
      : undefined;
  const started = performance.now();
  progress?.start();
  let report: Report;
  try {
    report = await analyzeProject(project, {
      production: values.prod === true,
      ...(githubToken && { githubToken }),
      ...(progress && { onProgress: (p: Progress) => progress.update(p) }),
    });
  } finally {
    progress?.stop();
  }
  const durationMs = performance.now() - started;

  const ci = values.ci
    ? evaluateCi(report, { failOn, ...(baseNames && baseRef && { base: baseRef, baseNames }) })
    : undefined;

  if (values.markdown !== undefined) {
    const markdown = ci ? formatCiMarkdown(report, ci) : formatReportMarkdown(report);
    if (values.markdown === '-') {
      process.stdout.write(markdown);
      return ci && !ci.passed ? 1 : 0;
    }
    await writeFile(values.markdown, markdown);
  }

  if (values.json) {
    const output = ci ? { ...report, ci: ciSummary(ci) } : report;
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    const color = !noColor && process.stdout.isTTY === true;
    const options = {
      all: values.all === true,
      color,
      links: color && supportsLinks(process.env),
      github: githubToken !== undefined,
      durationMs,
      ...(process.stdout.isTTY && process.stdout.columns && { width: process.stdout.columns }),
    };
    process.stdout.write(ci ? formatCi(report, ci, options) : formatReport(report, options));
  }
  return ci && !ci.passed ? 1 : 0;
}

function parseFailOn(value: string): FailLevel {
  if (!(FAIL_LEVELS as readonly string[]).includes(value)) {
    throw new UsageError(`--fail-on must be one of: ${FAIL_LEVELS.join(', ')} (got "${value}").`);
  }
  return value as FailLevel;
}

/** The CI verdict for `--json`: package ids instead of full package reports. */
function ciSummary(ci: CiResult) {
  return {
    passed: ci.passed,
    failOn: ci.failOn,
    ...(ci.base !== undefined && { base: ci.base }),
    newPackages: ci.newPackages,
    offenders: ci.offenders.map((pkg) => pkg.id),
    watch: ci.watch.map((pkg) => pkg.id),
  };
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const expected = error instanceof LockfileError || error instanceof UsageError;
    process.stderr.write(expected ? `${error.message}\n` : `${String(error)}\n`);
    process.exitCode = expected ? 2 : 1;
  },
);
