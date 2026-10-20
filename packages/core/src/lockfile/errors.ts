/** A lockfile is missing, malformed, or in a format Vitals does not support. */
export class LockfileError extends Error {
  override name = 'LockfileError';
}
