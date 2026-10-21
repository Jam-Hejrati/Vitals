import { REPLACEMENTS } from './data/replacements.js';

/** Something to use instead of a package, from the e18e `module-replacements` dataset. */
export interface Suggestion {
  kind: 'package' | 'native' | 'removal' | 'snippet';
  /** What to use instead: a package, a built-in feature, or a short description. */
  name: string;
  /** Extra context, for removals and snippets. */
  note?: string;
  /** Minimum Node.js version, for built-in features. */
  node?: string;
  url?: string;
}

/** Alternatives the e18e community recommends instead of `name`; empty when there are none. */
export function findReplacements(name: string): Suggestion[] {
  return Object.hasOwn(REPLACEMENTS, name) ? REPLACEMENTS[name]! : [];
}
