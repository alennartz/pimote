import { describe, expect, it, vi } from 'vitest';
import { filterLauncherCommands, parseLauncherQuery } from './query.js';
import type { LauncherCommand } from './contracts.js';

function makeCommand(id: string, label: string, overrides: Partial<LauncherCommand> = {}): LauncherCommand {
  return {
    id,
    label,
    group: 'app',
    run: vi.fn(),
    ...overrides,
  };
}

describe('parseLauncherQuery contract', () => {
  it('parses leading category prefixes and trims the remaining term', () => {
    expect(parseLauncherQuery('> settings')).toEqual({
      raw: '> settings',
      category: 'commands',
      prefix: '>',
      term: 'settings',
    });
    expect(parseLauncherQuery('  >   open branch  ')).toEqual({
      raw: '  >   open branch  ',
      category: 'commands',
      prefix: '>',
      term: 'open branch',
    });
    expect(parseLauncherQuery('@webhook')).toEqual({
      raw: '@webhook',
      category: 'sessions',
      prefix: '@',
      term: 'webhook',
    });
    expect(parseLauncherQuery('# pimote')).toEqual({
      raw: '# pimote',
      category: 'folders',
      prefix: '#',
      term: 'pimote',
    });
  });

  it('handles empty queries and bare prefixes cleanly', () => {
    expect(parseLauncherQuery('')).toEqual({ raw: '', category: 'all', prefix: null, term: '' });
    expect(parseLauncherQuery('   ')).toEqual({ raw: '   ', category: 'all', prefix: null, term: '' });
    expect(parseLauncherQuery('>')).toEqual({ raw: '>', category: 'commands', prefix: '>', term: '' });
    expect(parseLauncherQuery('@  ')).toEqual({ raw: '@  ', category: 'sessions', prefix: '@', term: '' });
    expect(parseLauncherQuery('#')).toEqual({ raw: '#', category: 'folders', prefix: '#', term: '' });
  });

  it('treats mid-string prefix symbols and leading slashes as unprefixed all-category search', () => {
    expect(parseLauncherQuery('foo > bar')).toEqual({
      raw: 'foo > bar',
      category: 'all',
      prefix: null,
      term: 'foo > bar',
    });
    expect(parseLauncherQuery('user@host')).toEqual({
      raw: 'user@host',
      category: 'all',
      prefix: null,
      term: 'user@host',
    });
    expect(parseLauncherQuery('issue #42')).toEqual({
      raw: 'issue #42',
      category: 'all',
      prefix: null,
      term: 'issue #42',
    });
    expect(parseLauncherQuery('/home/alenna/repos/pimote')).toEqual({
      raw: '/home/alenna/repos/pimote',
      category: 'all',
      prefix: null,
      term: '/home/alenna/repos/pimote',
    });
  });
});

describe('filterLauncherCommands contract', () => {
  it('excludes unavailable commands before filtering', () => {
    const commands = [
      makeCommand('home', 'Go to Home', { isAvailable: () => false }),
      makeCommand('settings', 'Open Settings', { isAvailable: () => true }),
      makeCommand('login', 'Open Provider Login'),
    ];

    expect(filterLauncherCommands(commands, '').map((c) => c.id)).toEqual(['settings', 'login']);
    expect(filterLauncherCommands(commands, 'home')).toEqual([]);
  });

  it('preserves declaration order on empty term and fuzzy-matches across label and keywords', () => {
    const commands = [
      makeCommand('settings', 'Open Settings', { keywords: ['preferences', 'config'] }),
      makeCommand('branch', 'Open Branch Explorer', { keywords: ['tree', 'history'] }),
      makeCommand('panels', 'Toggle Panels', { keywords: ['sidebar', 'drawer'] }),
    ];

    expect(filterLauncherCommands(commands, '   ').map((c) => c.id)).toEqual(['settings', 'branch', 'panels']);
    expect(filterLauncherCommands(commands, 'pref').map((c) => c.id)).toEqual(['settings']);
    expect(filterLauncherCommands(commands, 'tree branch').map((c) => c.id)).toEqual(['branch']);
    expect(filterLauncherCommands(commands, 'sbar').map((c) => c.id)).toEqual(['panels']);
  });
});
