import { describe, expect, it } from 'vitest';
import { findReplacements } from '../src/index.js';

describe('findReplacements', () => {
  it('suggests packages, built-in features and removal from the e18e dataset', () => {
    expect(findReplacements('moment').map((s) => s.name)).toEqual(
      expect.arrayContaining(['date-fns', 'day.js', 'luxon']),
    );
    expect(findReplacements('left-pad')).toMatchObject([
      { kind: 'native', name: 'String.prototype.padStart', node: '8.0.0' },
    ]);
    expect(findReplacements('lodash').map((s) => s.kind)).toContain('removal');
  });

  it('returns nothing for packages without a known replacement', () => {
    expect(findReplacements('react')).toEqual([]);
  });

  it('is not fooled by names that exist on every object', () => {
    expect(findReplacements('constructor')).toEqual([]);
    expect(findReplacements('__proto__')).toEqual([]);
  });
});
