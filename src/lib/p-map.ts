/**
 * Bounded-concurrency map. The SDK already throttles to ~6 req/s, so this is
 * only to cap in-flight work (and therefore memory) when fanning out over many
 * items — never to add throttling of our own.
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = 6,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
