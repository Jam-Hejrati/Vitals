import { copyFile } from 'node:fs/promises';

// npm only packs LICENSE and README.md from the package directory, so bring them from the repo root.
for (const file of ['LICENSE', 'README.md']) {
  await copyFile(
    new URL(`../../../${file}`, import.meta.url),
    new URL(`../${file}`, import.meta.url),
  );
}
