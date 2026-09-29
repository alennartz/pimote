import { goto } from '$app/navigation';
import { sessionRegistry } from './stores/session-registry.svelte.js';

/**
 * URL sync for the registry's viewed-session state.
 *
 * The registry owns which conversation is open; the URL mirrors it so browser
 * back/forward and reloads restore the same UI state (dashboard at `/`,
 * conversations at `/sessions/<id>`). Registered here — client-only — so the
 * registry module itself stays free of SvelteKit imports and unit-testable.
 * Before registration (SSR/tests) the registry just skips URL updates.
 */
sessionRegistry.setViewNavigator({
  toViewed(sessionId, { replace }: { replace: boolean }) {
    const url = sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : '/';
    // Dynamic route param — no static route for resolve(); base path is '/'
    // in this deployment.
    // eslint-disable-next-line svelte/no-navigation-without-resolve
    void goto(url, { replaceState: replace, keepFocus: true, noScroll: true });
  },
});
