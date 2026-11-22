import type { AppInfo } from '@pimote/shared';

/** Same-origin path the server serves each app's proxied icon from. */
export function appIconProxyPath(slug: string): string {
  return `/app-icons/${slug}`;
}

/** Icon display candidates in fallback order: configured icon, then the app's origin favicon. */
export function iconCandidates(app: AppInfo): string[] {
  const candidates: string[] = [];
  if (app.icon) {
    candidates.push(app.icon.toLowerCase().startsWith('data:') ? app.icon : appIconProxyPath(app.slug));
  }
  try {
    candidates.push(new URL('/favicon.ico', app.url).toString());
  } catch {
    // Unparseable app URL: skip the favicon candidate.
  }
  return candidates;
}

/** First grapheme of the title, for the letter fallback tile. */
export function appIconLetter(title: string): string {
  const first = [...title.trim()][0];
  return first ? first.toUpperCase() : '?';
}
