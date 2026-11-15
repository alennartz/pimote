export type CacheTokenUsage = Readonly<{
  input: number;
  cacheRead: number;
  cacheWrite: number;
}>;

/** Return cached reads as a share of all prompt tokens. */
export function formatCacheHitRate(usage: CacheTokenUsage): string | null {
  const values = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;

  const cacheTokens = usage.cacheRead + usage.cacheWrite;
  const promptTokens = usage.input + cacheTokens;
  if (cacheTokens === 0 || promptTokens === 0 || !Number.isFinite(promptTokens)) return null;

  const rate = ((usage.cacheRead / promptTokens) * 100).toFixed(1);
  return `${rate.endsWith('.0') ? rate.slice(0, -2) : rate}%`;
}
