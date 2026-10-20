import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assess, type PackageSignals, type Verdict } from '../src/index.js';

// The golden set: packages whose correct verdict we know, with signals recorded from the live
// registries (`pnpm golden:record`). Every scoring change must keep these verdicts right.

interface Label {
  package: string;
  expected: Verdict | Verdict[];
  why: string;
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`./golden/${file}`, import.meta.url), 'utf8'));

const labels = read<Label[]>('labels.json');
const recording = read<{ recordedAt: string; signals: Record<string, PackageSignals> }>(
  'signals.json',
);
const now = new Date(recording.recordedAt);

describe('golden set', () => {
  it.each(labels)('$package is $expected', (label) => {
    const signals = recording.signals[label.package];
    expect(signals, 'not recorded: run `pnpm golden:record`').toBeDefined();

    const assessment = assess(signals!, { now });
    const expected = ([] as Verdict[]).concat(label.expected);
    expect(
      expected,
      `${label.package} judged ${assessment.verdict} (${label.why})\n` +
        `  reasons: ${assessment.reasons.join('; ')}\n` +
        `  unknowns: ${assessment.unknowns.join('; ')}`,
    ).toContain(assessment.verdict);
  });
});
