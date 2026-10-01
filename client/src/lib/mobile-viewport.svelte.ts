/**
 * Reactive read of the app's mobile breakpoint (`max-width: 767px`, the same
 * breakpoint used by Tailwind's `max-md:` classes throughout the UI).
 *
 * State is seeded from `matchMedia` at module load — the app is CSR-only, and
 * seeding lazily inside the read would write `$state` while a template
 * expression evaluates, which Svelte forbids. Reads from component templates
 * and effects are tracked like any other rune state.
 */
const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)') : null;

let mobile = $state(query?.matches ?? false);

query?.addEventListener('change', (event) => {
  mobile = event.matches;
});

export function isMobileViewport(): boolean {
  return mobile;
}
