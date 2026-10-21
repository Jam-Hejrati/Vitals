// Bundles the CLI and everything it depends on (@vitals/core, yaml) into one file, so the
// published package has no dependencies to install. Run `tsc -b` first: @vitals/core resolves to
// its compiled output.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

await build({
  entryPoints: [path('../src/index.ts')],
  outfile: path('../dist/vitals.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  // Some bundled code still calls require() for Node's built-in modules.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
