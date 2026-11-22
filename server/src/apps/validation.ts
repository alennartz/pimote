import type { AppsConfig } from './types.js';

export const DEFAULT_CADDY_LISTEN = '127.0.0.1:8080';
export const DEFAULT_CADDY_SERVER_NAME = 'pimote_apps';

export const MAX_APP_SLUG_LENGTH = 63;
export const MAX_APP_TITLE_LENGTH = 100;
export const MAX_APP_DESCRIPTION_LENGTH = 280;
export const MAX_APP_ICON_LENGTH = 2048;

const APP_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CADDY_SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const SLUG_PLACEHOLDER = '{slug}';
const SAMPLE_SLUG = 'sample-app';

const BLOCKED_METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'metadata.azure.internal', 'instance-data']);

export function validateAppSlug(slug: string): string {
  if (typeof slug !== 'string') {
    throw new Error('App slug must be a string');
  }
  const normalized = slug.trim();
  if (normalized.length === 0 || normalized.length > MAX_APP_SLUG_LENGTH || !APP_SLUG_RE.test(normalized)) {
    throw new Error(`Invalid app slug ${JSON.stringify(slug)}: use 1 to ${MAX_APP_SLUG_LENGTH} lowercase letters, digits, and single separating hyphens`);
  }
  return normalized;
}

export function validateAppTitle(title: string): string {
  if (typeof title !== 'string') {
    throw new Error('App title must be a string');
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error('App title must not be empty');
  }
  if (trimmed.length > MAX_APP_TITLE_LENGTH) {
    throw new Error(`App title must be ${MAX_APP_TITLE_LENGTH} characters or fewer`);
  }
  return trimmed;
}

export function validateAppDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== 'string') {
    throw new Error('App description must be a string');
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_APP_DESCRIPTION_LENGTH) {
    throw new Error(`App description must be ${MAX_APP_DESCRIPTION_LENGTH} characters or fewer`);
  }
  return trimmed;
}

export interface IconValidationOptions {
  /** Localhost TCP ports owned by Pimote or Caddy that must never be fetched from. */
  blockedLocalPorts?: ReadonlyMap<number, string>;
}

/** Validate an optional app icon URL: http(s) image URL or data:image URI. Blank clears the icon. */
export function validateAppIcon(icon: string | undefined, options: IconValidationOptions = {}): string | undefined {
  if (icon === undefined) return undefined;
  if (typeof icon !== 'string') {
    throw new Error('App icon must be a string');
  }
  const trimmed = icon.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_APP_ICON_LENGTH) {
    throw new Error(`App icon URL must be ${MAX_APP_ICON_LENGTH} characters or fewer`);
  }

  if (trimmed.toLowerCase().startsWith('data:image/')) {
    const commaIndex = trimmed.indexOf(',');
    if (commaIndex === -1 || commaIndex === trimmed.length - 1) {
      throw new Error('App icon data URI must carry base64 payload');
    }
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid app icon URL: ${JSON.stringify(icon)}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`App icon URL must use http:// or https:// (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('App icon URL must not include embedded credentials');
  }
  if (isMetadataOrLinkLocalHost(parsed.hostname)) {
    throw new Error(`App icon URL host is blocked (link-local or cloud metadata address): ${parsed.hostname}`);
  }
  if (options.blockedLocalPorts && isLocalInterfaceHost(parsed.hostname)) {
    const port = effectivePort(parsed);
    const reason = options.blockedLocalPorts.get(port);
    if (reason) {
      throw new Error(`App icon URL cannot target local port ${port} (${reason})`);
    }
  }

  return trimmed;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Extract IPv4 octets from a dotted IPv4 address or WHATWG-normalized IPv4-mapped IPv6 (`::ffff:a9fe:a9fe` or `::ffff:169.254.169.254`). */
function extractIpv4Octets(hostname: string): [number, number, number, number] | null {
  const bare = stripIpv6Brackets(hostname).toLowerCase();

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map((part) => Number(part));
    if (octets.every((octet) => octet >= 0 && octet <= 255)) {
      return octets as [number, number, number, number];
    }
    return null;
  }

  if (bare.startsWith('::ffff:')) {
    const suffix = bare.slice('::ffff:'.length);
    const dotted = extractIpv4Octets(suffix);
    if (dotted) return dotted;
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    }
  }

  return null;
}

export function isLoopbackHost(hostname: string): boolean {
  const bare = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
  if (bare === 'localhost' || bare === '::1') return true;
  const ipv4 = extractIpv4Octets(bare);
  return ipv4 !== null && ipv4[0] === 127;
}

function isLocalInterfaceHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  const bare = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
  if (bare === '::' || bare === '0:0:0:0:0:0:0:0') return true;
  const ipv4 = extractIpv4Octets(bare);
  return ipv4 !== null && ipv4[0] === 0 && ipv4[1] === 0 && ipv4[2] === 0 && ipv4[3] === 0;
}

function isMetadataOrLinkLocalHost(hostname: string): boolean {
  const bare = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
  if (BLOCKED_METADATA_HOSTS.has(bare)) return true;

  const ipv4 = extractIpv4Octets(bare);
  if (ipv4 !== null) {
    // 169.254.0.0/16 (link-local & AWS/GCP/Azure IMDS)
    if (ipv4[0] === 169 && ipv4[1] === 254) return true;
    return false;
  }

  // AWS IPv6 IMDS (fd00:ec2::254)
  if (bare === 'fd00:ec2::254') return true;

  // IPv6 link-local fe80::/10 (fe80..febf)
  const firstHextet = /^([0-9a-f]{1,4}):/.exec(bare);
  if (firstHextet) {
    const value = parseInt(firstHextet[1]!, 16);
    if ((value & 0xffc0) === 0xfe80) return true;
  }

  return false;
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Extract the numeric TCP port from a Caddy listen string such as `127.0.0.1:8080`, `:8080`, or `[::1]:8080`. */
export function parseListenPort(listen: string): number | null {
  const match = /:(\d+)$/.exec(listen.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function validatePublicUrlTemplate(template: string, field = 'apps.publicUrlTemplate'): string {
  if (typeof template !== 'string' || template.trim().length === 0) {
    throw new Error(`Config "${field}" must be a non-empty URL template containing "${SLUG_PLACEHOLDER}"`);
  }

  const trimmed = template.trim().replace(/\/+$/, '');
  const firstIdx = trimmed.indexOf(SLUG_PLACEHOLDER);
  if (firstIdx === -1 || trimmed.indexOf(SLUG_PLACEHOLDER, firstIdx + SLUG_PLACEHOLDER.length) !== -1) {
    throw new Error(`Config "${field}" must contain "${SLUG_PLACEHOLDER}" exactly once`);
  }

  const sample = trimmed.replace(SLUG_PLACEHOLDER, SAMPLE_SLUG);
  let parsed: URL;
  try {
    parsed = new URL(sample);
  } catch {
    throw new Error(`Config "${field}" is not a valid URL template: ${JSON.stringify(template)}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Config "${field}" must use http:// or https://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Config "${field}" must not include credentials`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`Config "${field}" must be an origin without a path, query, or hash`);
  }
  if (!parsed.hostname.includes(SAMPLE_SLUG)) {
    throw new Error(`Config "${field}" must place "${SLUG_PLACEHOLDER}" inside the hostname`);
  }

  // Verify the maximum 63-character slug still produces valid DNS label lengths.
  const maxSlugSample = trimmed.replace(SLUG_PLACEHOLDER, 'a'.repeat(MAX_APP_SLUG_LENGTH));
  const maxHost = new URL(maxSlugSample).hostname;
  if (maxHost.length > 253 || maxHost.split('.').some((label) => label.length === 0 || label.length > 63)) {
    throw new Error(`Config "${field}" exceeds DNS label limits for a ${MAX_APP_SLUG_LENGTH}-character slug`);
  }

  return trimmed;
}

export function validateCaddyAdminUrl(rawUrl: string, field = 'apps.caddyAdminUrl'): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error(`Config "${field}" must be a non-empty loopback HTTP URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Config "${field}" is not a valid URL: ${JSON.stringify(rawUrl)}`);
  }

  if (parsed.protocol !== 'http:') {
    throw new Error(`Config "${field}" must use http://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Config "${field}" must not include credentials`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`Config "${field}" must be an origin without a path, query, or hash`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(`Config "${field}" must target a loopback address (localhost, 127.0.0.1, or ::1)`);
  }

  return parsed.origin;
}

export function parseAppsConfig(value: unknown, configPath: string): AppsConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config "apps" must be an object in ${configPath}`);
  }

  const obj = value as Record<string, unknown>;
  const publicUrlTemplate = validatePublicUrlTemplate(obj.publicUrlTemplate as string, 'apps.publicUrlTemplate');
  const caddyAdminUrl = validateCaddyAdminUrl(obj.caddyAdminUrl as string, 'apps.caddyAdminUrl');

  let caddyListen = DEFAULT_CADDY_LISTEN;
  if (obj.caddyListen !== undefined) {
    if (typeof obj.caddyListen !== 'string' || obj.caddyListen.trim().length === 0 || /\s/.test(obj.caddyListen.trim())) {
      throw new Error(`Config "apps.caddyListen" must be a non-empty listen address without spaces in ${configPath}`);
    }
    caddyListen = obj.caddyListen.trim();
  }

  let caddyServerName = DEFAULT_CADDY_SERVER_NAME;
  if (obj.caddyServerName !== undefined) {
    if (typeof obj.caddyServerName !== 'string' || !CADDY_SERVER_NAME_RE.test(obj.caddyServerName)) {
      throw new Error(`Config "apps.caddyServerName" must match ${CADDY_SERVER_NAME_RE} in ${configPath}`);
    }
    caddyServerName = obj.caddyServerName;
  }

  return {
    publicUrlTemplate,
    caddyAdminUrl,
    caddyListen,
    caddyServerName,
  };
}

export function renderPublicUrl(template: string, slug: string): string {
  const validSlug = validateAppSlug(slug);
  return template.replace(SLUG_PLACEHOLDER, validSlug);
}

export function renderAppHostname(template: string, slug: string): string {
  return new URL(renderPublicUrl(template, slug)).hostname;
}

export interface TargetValidationOptions {
  /** Localhost TCP ports owned by Pimote or Caddy that must never be proxied to. */
  blockedLocalPorts?: ReadonlyMap<number, string>;
}

export function validateAppTarget(rawTarget: string, options: TargetValidationOptions = {}): string {
  if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) {
    throw new Error('App target must be a non-empty http:// or https:// origin URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawTarget.trim());
  } catch {
    throw new Error(`Invalid app target URL: ${JSON.stringify(rawTarget)}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`App target must use http:// or https:// (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('App target must not include embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('App target must be an origin without query strings or fragments');
  }
  if (parsed.pathname !== '/') {
    throw new Error(`App target must be an origin without a base path (got path ${JSON.stringify(parsed.pathname)})`);
  }
  if (isMetadataOrLinkLocalHost(parsed.hostname)) {
    throw new Error(`App target host is blocked (link-local or cloud metadata address): ${parsed.hostname}`);
  }

  if (options.blockedLocalPorts && isLocalInterfaceHost(parsed.hostname)) {
    const port = effectivePort(parsed);
    const reason = options.blockedLocalPorts.get(port);
    if (reason) {
      throw new Error(`App target cannot route to local port ${port} (${reason})`);
    }
  }

  return parsed.origin;
}

export function buildBlockedLocalPorts(config: AppsConfig, pimotePort: number): Map<number, string> {
  const blocked = new Map<number, string>();
  blocked.set(pimotePort, 'Pimote server port');
  const adminPort = effectivePort(new URL(config.caddyAdminUrl));
  blocked.set(adminPort, 'Caddy admin API port');
  const listenPort = parseListenPort(config.caddyListen);
  if (listenPort !== null) {
    blocked.set(listenPort, 'Caddy listen port');
  }
  return blocked;
}

export function targetToCaddyDial(normalizedTarget: string): { dial: string; isHttps: boolean } {
  const parsed = new URL(normalizedTarget);
  const port = effectivePort(parsed);
  return {
    dial: `${parsed.hostname}:${port}`,
    isHttps: parsed.protocol === 'https:',
  };
}
