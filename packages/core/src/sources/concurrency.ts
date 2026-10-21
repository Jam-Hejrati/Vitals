/** How many of `total` items are done, reported while a slow lookup runs. */
export type OnProgress = (done: number, total: number) => void;

/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` calls in flight. `onEach` runs after
 * every finished call.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onEach?: () => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
      onEach?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * An `onEach` for `mapLimit` over the `missing` part of `all` keys: the cached ones count as done
 * from the start.
 */
export function progressOf(
  all: readonly unknown[],
  missing: readonly unknown[],
  onProgress: OnProgress | undefined,
): (() => void) | undefined {
  if (!onProgress) return undefined;
  const total = new Set(all).size;
  let done = total - missing.length;
  onProgress(done, total);
  return () => onProgress(++done, total);
}
