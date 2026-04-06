import { describe, expect, it } from 'vitest';
import type { FolderInfo, SessionInfo } from '@pimote/shared';
import { buildSessionProjectGroups } from './session-list-groups.js';

function folder(path: string, name: string): FolderInfo {
  return {
    path,
    name,
    activeSessionCount: 0,
    externalProcessCount: 0,
    activeStatus: null,
  };
}

function session(id: string, modified: string, created = modified): SessionInfo {
  return {
    id,
    created,
    modified,
    messageCount: 1,
  };
}

describe('buildSessionProjectGroups', () => {
  it('omits folders with no visible sessions', () => {
    const groups = buildSessionProjectGroups(
      [folder('/a', 'alpha'), folder('/b', 'beta')],
      new Map([
        ['/a', [session('a1', '2026-04-05T10:00:00.000Z')]],
        ['/b', []],
      ]),
    );

    expect(groups.map((group) => group.folder.name)).toEqual(['alpha']);
  });

  it('sorts sessions newest-first within each project', () => {
    const groups = buildSessionProjectGroups(
      [folder('/a', 'alpha')],
      new Map([['/a', [session('older', '2026-04-01T10:00:00.000Z'), session('newer', '2026-04-05T12:00:00.000Z'), session('middle', '2026-04-03T09:00:00.000Z')]]]),
    );

    expect(groups[0].sessions.map((item) => item.id)).toEqual(['newer', 'middle', 'older']);
    expect(groups[0].lastModified).toBe('2026-04-05T12:00:00.000Z');
  });

  it('sorts project groups by their most recently active session', () => {
    const groups = buildSessionProjectGroups(
      [folder('/a', 'alpha'), folder('/b', 'beta'), folder('/c', 'charlie')],
      new Map([
        ['/a', [session('a1', '2026-04-01T10:00:00.000Z')]],
        ['/b', [session('b1', '2026-04-06T08:00:00.000Z')]],
        ['/c', [session('c1', '2026-04-03T09:00:00.000Z')]],
      ]),
    );

    expect(groups.map((group) => group.folder.name)).toEqual(['beta', 'charlie', 'alpha']);
  });
});
