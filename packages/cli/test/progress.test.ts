import { describe, expect, it } from 'vitest';
import { overall, ProgressLine } from '../src/progress.js';

describe('overall', () => {
  const all = ['packages', 'details', 'inactive', 'github'] as const;

  it('weighs the stages and counts the finished ones in full', () => {
    expect(overall({ stage: 'packages', done: 0, total: 10 }, all)).toBe(0);
    expect(overall({ stage: 'packages', done: 5, total: 10 }, all)).toBeCloseTo(0.3);
    expect(overall({ stage: 'github', done: 4, total: 4 }, all)).toBeCloseTo(1);
  });

  it('spreads the bar over the stages that run', () => {
    const withoutGithub = ['packages', 'details', 'inactive'] as const;
    expect(overall({ stage: 'inactive', done: 1, total: 1 }, withoutGithub)).toBeCloseTo(1);
  });

  it('treats an empty stage as done', () => {
    expect(overall({ stage: 'inactive', done: 0, total: 0 }, all)).toBeCloseTo(0.9);
  });
});

describe('ProgressLine', () => {
  it('draws a line, then clears it and restores the cursor', () => {
    let written = '';
    const stream = { columns: 120, write: (text: string) => (written += text) };
    const line = new ProgressLine(stream as unknown as NodeJS.WriteStream, {
      github: false,
      color: false,
    });
    line.start();
    line.update({ stage: 'packages', done: 50, total: 100 });
    line.stop();
    expect(written).toContain('Checking dependencies');
    expect(written.endsWith('\r\x1b[K\x1b[?25h')).toBe(true);
  });
});
