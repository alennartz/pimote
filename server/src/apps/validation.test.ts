import { describe, expect, it } from 'vitest';
import {
  buildBlockedLocalPorts,
  DEFAULT_CADDY_LISTEN,
  DEFAULT_CADDY_SERVER_NAME,
  parseAppsConfig,
  renderAppHostname,
  renderPublicUrl,
  targetToCaddyDial,
  validateAppDescription,
  validateAppSlug,
  validateAppTarget,
  validateAppTitle,
} from './validation.js';

describe('parseAppsConfig', () => {
  it('returns undefined when absent', () => {
    expect(parseAppsConfig(undefined, 'config.json')).toBeUndefined();
  });

  it('parses valid config and fills Caddy defaults', () => {
    const parsed = parseAppsConfig(
      {
        publicUrlTemplate: 'https://{slug}.apps.example.com/',
        caddyAdminUrl: 'http://127.0.0.1:2019/',
      },
      'config.json',
    );
    expect(parsed).toEqual({
      publicUrlTemplate: 'https://{slug}.apps.example.com',
      caddyAdminUrl: 'http://127.0.0.1:2019',
      caddyListen: DEFAULT_CADDY_LISTEN,
      caddyServerName: DEFAULT_CADDY_SERVER_NAME,
    });
  });

  it('rejects non-loopback Caddy admin URLs', () => {
    expect(() =>
      parseAppsConfig(
        {
          publicUrlTemplate: 'https://{slug}.apps.example.com',
          caddyAdminUrl: 'http://192.168.1.50:2019',
        },
        'config.json',
      ),
    ).toThrow(/loopback/i);
  });

  it('rejects publicUrlTemplate without {slug} in hostname or with a path', () => {
    expect(() =>
      parseAppsConfig(
        {
          publicUrlTemplate: 'https://apps.example.com/{slug}',
          caddyAdminUrl: 'http://127.0.0.1:2019',
        },
        'config.json',
      ),
    ).toThrow();

    expect(() =>
      parseAppsConfig(
        {
          publicUrlTemplate: 'https://apps.example.com',
          caddyAdminUrl: 'http://127.0.0.1:2019',
        },
        'config.json',
      ),
    ).toThrow(/\{slug\}/);
  });
});

describe('slug, title, and description validation', () => {
  it('accepts DNS-safe slugs up to 63 chars and rejects invalid slugs', () => {
    expect(validateAppSlug('my-app-1')).toBe('my-app-1');
    expect(validateAppSlug('a'.repeat(63))).toBe('a'.repeat(63));
    expect(() => validateAppSlug('')).toThrow();
    expect(() => validateAppSlug('a'.repeat(64))).toThrow();
    expect(() => validateAppSlug('-leading')).toThrow();
    expect(() => validateAppSlug('trailing-')).toThrow();
    expect(() => validateAppSlug('double--hyphen')).toThrow();
    expect(() => validateAppSlug('UpperCase')).toThrow();
  });

  it('trims titles and treats blank descriptions as omitted', () => {
    expect(validateAppTitle('  Budget App  ')).toBe('Budget App');
    expect(() => validateAppTitle('   ')).toThrow();
    expect(validateAppDescription('   ')).toBeUndefined();
    expect(validateAppDescription('  Expense viewer ')).toBe('Expense viewer');
  });
});

describe('validateAppTarget', () => {
  const blockedLocalPorts = buildBlockedLocalPorts(
    {
      publicUrlTemplate: 'https://{slug}.apps.example.com',
      caddyAdminUrl: 'http://127.0.0.1:2019',
      caddyListen: '127.0.0.1:8080',
      caddyServerName: 'pimote_apps',
    },
    3000,
  );

  it('normalizes valid localhost, LAN, and remote http/https origins', () => {
    expect(validateAppTarget('http://127.0.0.1:4173/', { blockedLocalPorts })).toBe('http://127.0.0.1:4173');
    expect(validateAppTarget('http://192.168.1.25:9000', { blockedLocalPorts })).toBe('http://192.168.1.25:9000');
    expect(validateAppTarget('https://dashboard.internal:8443/', { blockedLocalPorts })).toBe('https://dashboard.internal:8443');
  });

  it('blocks Pimote, Caddy admin, and Caddy listen ports on loopback and wildcard local interfaces', () => {
    expect(() => validateAppTarget('http://127.0.0.1:3000', { blockedLocalPorts })).toThrow(/Pimote server port/);
    expect(() => validateAppTarget('http://localhost:2019', { blockedLocalPorts })).toThrow(/Caddy admin API port/);
    expect(() => validateAppTarget('http://[::1]:8080', { blockedLocalPorts })).toThrow(/Caddy listen port/);
    expect(() => validateAppTarget('http://0.0.0.0:3000', { blockedLocalPorts })).toThrow(/Pimote server port/);
    expect(() => validateAppTarget('http://[::ffff:127.0.0.1]:2019', { blockedLocalPorts })).toThrow(/Caddy admin API port/);
  });

  it('allows the same port numbers on non-local hosts', () => {
    expect(validateAppTarget('http://192.168.1.40:3000', { blockedLocalPorts })).toBe('http://192.168.1.40:3000');
  });

  it('blocks cloud metadata and link-local addresses across IPv4, IPv6, and hostnames', () => {
    expect(() => validateAppTarget('http://169.254.169.254', { blockedLocalPorts })).toThrow(/metadata/i);
    expect(() => validateAppTarget('http://[::ffff:169.254.169.254]', { blockedLocalPorts })).toThrow(/metadata/i);
    expect(() => validateAppTarget('http://[fd00:ec2::254]', { blockedLocalPorts })).toThrow(/metadata/i);
    expect(() => validateAppTarget('http://[fe80::1]:8081', { blockedLocalPorts })).toThrow(/metadata/i);
    expect(() => validateAppTarget('http://metadata.google.internal', { blockedLocalPorts })).toThrow(/metadata/i);
  });

  it('rejects non-http schemes, credentials, paths, queries, and hashes', () => {
    expect(() => validateAppTarget('ws://127.0.0.1:4173')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => validateAppTarget('http://user:pass@127.0.0.1:4173')).toThrow(/credentials/i);
    expect(() => validateAppTarget('http://127.0.0.1:4173/subpath')).toThrow(/base path/i);
    expect(() => validateAppTarget('http://127.0.0.1:4173/?a=1')).toThrow(/query/i);
    expect(() => validateAppTarget('http://127.0.0.1:4173/#hash')).toThrow(/fragments/i);
  });
});

describe('public URL and Caddy dial helpers', () => {
  it('renders public URLs and extracts hostnames without port', () => {
    expect(renderPublicUrl('https://{slug}.apps.example.com', 'notes')).toBe('https://notes.apps.example.com');
    expect(renderAppHostname('http://{slug}.apps.localhost:8080', 'notes')).toBe('notes.apps.localhost');
  });

  it('builds explicit host:port dial strings for HTTP and HTTPS targets', () => {
    expect(targetToCaddyDial('http://127.0.0.1:4173')).toEqual({ dial: '127.0.0.1:4173', isHttps: false });
    expect(targetToCaddyDial('http://example.internal')).toEqual({ dial: 'example.internal:80', isHttps: false });
    expect(targetToCaddyDial('https://example.internal')).toEqual({ dial: 'example.internal:443', isHttps: true });
  });
});
