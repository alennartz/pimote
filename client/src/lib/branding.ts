export const DEFAULT_APP_NAME = 'Pimote';

/**
 * App display name. The pimote server injects the host's configured name into
 * the HTML shell (`<meta name="application-name">`); this reads it back so the
 * UI never hardcodes a host's chosen name. Falls back to the default outside a
 * document (dev server, service worker, tests).
 */
export function getAppName(): string {
  if (typeof document === 'undefined') return DEFAULT_APP_NAME;
  const meta = document.querySelector('meta[name="application-name"]')?.getAttribute('content')?.trim();
  return meta || DEFAULT_APP_NAME;
}
