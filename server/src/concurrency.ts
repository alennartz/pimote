/** Bounded-concurrency map preserving input order in the results. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Race `promise` against `signal` (DR-072): the caller rejects at once on
 *  abort while the raced work runs to completion — request paths abort,
 *  server-owned work finishes. The race subscribes to `promise`, so its
 *  eventual settlement never becomes an unhandled rejection. */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
}
