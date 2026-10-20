// Records live signals for the golden set, so the golden test runs offline and repeatably.
// Usage: pnpm golden:record   (re-run occasionally to notice real-world changes)
import { readFile, writeFile } from 'node:fs/promises';
import { collectSignals, MemoryCache, packageId } from '../dist/index.js';

const labelsUrl = new URL('../test/golden/labels.json', import.meta.url);
const signalsUrl = new URL('../test/golden/signals.json', import.meta.url);

const labels = JSON.parse(await readFile(labelsUrl, 'utf8'));
const packages = new Map();
for (const label of labels) {
  const at = label.package.lastIndexOf('@');
  const name = label.package.slice(0, at);
  const version = label.package.slice(at + 1);
  const id = packageId(name, version);
  packages.set(id, {
    id,
    name,
    version,
    dev: false,
    optional: false,
    local: false,
    dependencies: [],
  });
}

const graph = {
  root: { name: 'golden', version: '0.0.0' },
  directDependencies: [...packages.keys()].map((id) => ({ id, type: 'prod', importer: '.' })),
  packages,
};

const recordedAt = new Date();
// A fresh cache, so the recording reflects the registries today.
const signals = await collectSignals(graph, { cache: new MemoryCache(), now: recordedAt });

const sorted = Object.fromEntries([...signals].sort(([a], [b]) => a.localeCompare(b)));
await writeFile(
  signalsUrl,
  JSON.stringify({ recordedAt: recordedAt.toISOString(), signals: sorted }, null, 2) + '\n',
);
console.log(`Recorded ${signals.size} packages at ${recordedAt.toISOString()}`);
