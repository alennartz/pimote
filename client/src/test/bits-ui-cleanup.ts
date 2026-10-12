/** Wait out bits-ui's delayed body scroll lock cleanup.
 *
 *  bits-ui resets the body style on a 24ms timer after the last modal
 *  unmounts (body-scroll-lock.svelte.js). The cleanup guards with BROWSER,
 *  a constant captured at module load, so it dereferences `document` even
 *  after vitest tore down jsdom and removed the global. The file then fails
 *  with "document is not defined" — observed in CI, not locally.
 *
 *  Call this in afterEach after unmount. 40ms clears the 24ms delay plus
 *  margin; the timer was scheduled first, so it always fires first. */
export async function drainBodyScrollLockCleanup(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}
