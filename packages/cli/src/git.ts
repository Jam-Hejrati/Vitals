import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UsageError } from './errors.js';

const run = promisify(execFile);

/**
 * The content of `file` (relative to `dir`) as committed at `ref`, or `undefined` when the file
 * did not exist there. Throws a `UsageError` when git is missing or `ref` is not a commit.
 */
export async function readFileAtRef(
  dir: string,
  ref: string,
  file: string,
): Promise<string | undefined> {
  if (ref.startsWith('-')) throw new UsageError(`Invalid git ref "${ref}".`);
  const git = async (args: string[]) =>
    (await run('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1024 ** 3 })).stdout;

  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError('git is required for --base, but it was not found.');
    }
    throw new UsageError(
      `Cannot find "${ref}" in this repository. In CI the history must be available: ` +
        'with GitHub Actions, use actions/checkout with fetch-depth: 0.',
    );
  }

  const prefix = (await git(['rev-parse', '--show-prefix'])).trim();
  try {
    return await git(['show', `${ref}:${prefix}${file}`]);
  } catch {
    return undefined;
  }
}
