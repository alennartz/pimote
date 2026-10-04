/**
 * App display name branding.
 *
 * A single config value (`appName` in the pimote config) drives every place the
 * app's name surfaces: the served PWA manifest (installed app name), the HTML
 * shell's meta tags (iOS installed name and the client's title fallbacks), and
 * the browser tab title. The server rewrites the built static assets on the way
 * out, so hosts only set `appName` — no client rebuild required.
 */

export const DEFAULT_APP_NAME = 'Pimote';

/** The configured app name, trimmed; falls back to the default when absent or blank. */
export function resolveAppName(config: { appName?: string }): string {
  const name = config.appName?.trim();
  return name ? name : DEFAULT_APP_NAME;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replace the `content` of `<meta name="…">` in an HTML document. No-op if that meta is absent. */
export function setMetaContent(html: string, metaName: string, content: string): string {
  const tagPattern = new RegExp(`<meta\\b[^>]*\\bname="${metaName}"[^>]*>`, 'i');
  const tag = html.match(tagPattern)?.[0];
  if (!tag) return html;
  const escaped = escapeHtmlAttribute(content);
  const updated = /\bcontent="/.test(tag) ? tag.replace(/\bcontent="[^"]*"/, `content="${escaped}"`) : tag.replace(/\s*\/?>$/, (closing) => ` content="${escaped}"${closing}`);
  return html.replace(tagPattern, () => updated);
}

/** Meta tags in the HTML shell that carry the app name. */
const BRANDED_META_NAMES = ['application-name', 'apple-mobile-web-app-title'] as const;

/** Rewrite every branded value in the HTML shell to the configured app name. */
export function applyAppNameToHtml(html: string, appName: string): string {
  let out = html;
  for (const metaName of BRANDED_META_NAMES) {
    out = setMetaContent(out, metaName, appName);
  }
  return out;
}

/** Rewrite the PWA manifest's name fields to the configured app name. */
export function applyAppNameToManifest(raw: string, appName: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw;
  const manifest = parsed as Record<string, unknown>;
  manifest.name = appName;
  manifest.short_name = appName;
  return JSON.stringify(manifest);
}
