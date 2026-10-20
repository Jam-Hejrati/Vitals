// Checks that the CLI package works for someone who installs it: packs it, installs the tarball
// into an empty project, and runs it. Nothing is published.
// Usage: pnpm release:check
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliDir = join(root, 'packages', 'cli');
const manifest = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

const problems = [];
const check = (ok, message) => {
  console.log(`${ok ? '✔' : '✖'} ${message}`);
  if (!ok) problems.push(message);
};

const work = await mkdtemp(join(tmpdir(), 'vitals-release-'));
try {
  run('pnpm', ['-C', 'packages/cli', 'build'], root);

  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', work], cliDir));
  const files = packed.files.map((file) => file.path).sort();
  check(
    JSON.stringify(files) ===
      JSON.stringify(['LICENSE', 'README.md', 'dist/vitals.js', 'package.json']),
    `the package contains exactly LICENSE, README.md, dist/vitals.js and package.json (found: ${files.join(', ')})`,
  );
  check(packed.size < 500_000, `the tarball is small (${Math.round(packed.size / 1024)} KB)`);
  check(
    !manifest.dependencies || Object.keys(manifest.dependencies).length === 0,
    'it has no runtime dependencies to install',
  );

  await writeFile(join(work, 'package.json'), '{"name":"consumer","version":"1.0.0"}\n');
  run(npm, ['install', '--no-audit', '--no-fund', join(work, packed.filename)], work);

  const installed = join(work, 'node_modules', manifest.name, 'dist', 'vitals.js');
  const version = run('node', [installed, '--version'], work).trim();
  check(version === manifest.version, `--version prints ${manifest.version} (got ${version})`);
  check(run('node', [installed, '--help'], work).includes('Usage: vitals'), '--help works');

  // `npm install` left a lockfile in the consumer project, so look at an empty folder instead.
  const empty = join(work, 'empty');
  await mkdir(empty);
  let exitCode = 0;
  try {
    run('node', [installed, empty], work);
  } catch (error) {
    exitCode = error.status;
  }
  // No lockfile there: a clear error (exit code 2), not a crash.
  check(exitCode === 2, 'a project without a lockfile exits with code 2');
} finally {
  await rm(work, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s). Not ready to publish.`);
  process.exitCode = 1;
} else {
  console.log('\nThe package looks good.');
}
