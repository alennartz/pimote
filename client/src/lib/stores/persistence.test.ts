import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PersistedSession } from './persistence.js';

// ---------------------------------------------------------------------------
// Storage mocks — Node v25 has a built-in localStorage that shadows jsdom's,
// but it's non-functional without --localstorage-file. We provide our own
// Map-backed mocks on globalThis to test the persistence module. localStorage
// and sessionStorage get separate maps, so tests can pin which storage a
// value lands in.
// ---------------------------------------------------------------------------

let mockLocalStorage: Storage;
let mockSessionStorage: Storage;

function createMockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  };
}

beforeEach(() => {
  mockLocalStorage = createMockStorage();
  mockSessionStorage = createMockStorage();
  vi.stubGlobal('localStorage', mockLocalStorage);
  vi.stubGlobal('sessionStorage', mockSessionStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Dynamic import to pick up the stubbed localStorage each time.
// The module is pure functions that reference `localStorage` at call time,
// so a static import works fine.
const {
  getClientId,
  setClientId,
  getActiveSessions,
  setActiveSessions,
  clearActiveSessions,
  getUser,
  setUser,
  getShowArchived,
  setShowArchived,
  getSessionPillSwipeHintShown,
  setSessionPillSwipeHintShown,
  getSessionDraft,
  setSessionDraft,
  clearSessionDraft,
} = await import('./persistence.js');

describe('Persistence — Client ID', () => {
  it('returns null when no clientId has been stored', () => {
    expect(getClientId()).toBeNull();
  });

  it('round-trips a clientId through set and get', () => {
    setClientId('abc-123');
    expect(getClientId()).toBe('abc-123');
  });

  it('overwrites a previously stored clientId', () => {
    setClientId('first');
    setClientId('second');
    expect(getClientId()).toBe('second');
  });

  it('keeps the client id out of localStorage — tabs must not share it', () => {
    setClientId('tab-local');
    expect(mockSessionStorage.getItem('pimote:clientId')).toBe('tab-local');
    expect(mockLocalStorage.getItem('pimote:clientId')).toBeNull();
  });

  it('returns null when sessionStorage.getItem throws', () => {
    vi.spyOn(mockSessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(getClientId()).toBeNull();
  });

  it('silently swallows errors on setClientId', () => {
    vi.spyOn(mockSessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setClientId('abc')).not.toThrow();
  });
});

describe('Persistence — User', () => {
  it('returns null before any user has been set', () => {
    expect(getUser()).toBeNull();
  });

  it('round-trips the user name through set and get', () => {
    setUser('alenna');
    expect(getUser()).toBe('alenna');
  });

  it('overwrites a previously stored user', () => {
    setUser('alenna');
    setUser('default');
    expect(getUser()).toBe('default');
  });

  it('normalizes the stored name to the server-side profile key rule', () => {
    setUser('  alenna  ');
    expect(getUser()).toBe('alenna');
    setUser('a'.repeat(100));
    expect(getUser()).toBe('a'.repeat(64));
  });
});

describe('Persistence — Active Sessions', () => {
  it('returns an empty array when nothing is stored', () => {
    expect(getActiveSessions()).toEqual([]);
  });

  it('round-trips a list of sessions through set and get', () => {
    const sessions: PersistedSession[] = [
      { sessionId: 's1', folderPath: '/home/user/project-a' },
      { sessionId: 's2', folderPath: '/home/user/project-b' },
    ];
    setActiveSessions(sessions);
    expect(getActiveSessions()).toEqual(sessions);
  });

  it('returns an empty array for an empty stored list', () => {
    setActiveSessions([]);
    expect(getActiveSessions()).toEqual([]);
  });

  it('filters out entries with missing sessionId', () => {
    mockLocalStorage.setItem('pimote:activeSessions', JSON.stringify([{ sessionId: 's1', folderPath: '/path' }, { folderPath: '/no-session-id' }]));
    const result = getActiveSessions();
    expect(result).toEqual([{ sessionId: 's1', folderPath: '/path' }]);
  });

  it('filters out entries with missing folderPath', () => {
    mockLocalStorage.setItem('pimote:activeSessions', JSON.stringify([{ sessionId: 's1' }, { sessionId: 's2', folderPath: '/path' }]));
    const result = getActiveSessions();
    expect(result).toEqual([{ sessionId: 's2', folderPath: '/path' }]);
  });

  it('filters out non-object entries', () => {
    mockLocalStorage.setItem('pimote:activeSessions', JSON.stringify(['not-an-object', 42, null]));
    expect(getActiveSessions()).toEqual([]);
  });

  it('returns an empty array when stored value is not a JSON array', () => {
    mockLocalStorage.setItem('pimote:activeSessions', '"just a string"');
    expect(getActiveSessions()).toEqual([]);
  });

  it('returns an empty array when stored value is invalid JSON', () => {
    mockLocalStorage.setItem('pimote:activeSessions', '{broken json');
    expect(getActiveSessions()).toEqual([]);
  });

  it('returns an empty array when localStorage.getItem throws', () => {
    vi.spyOn(mockLocalStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(getActiveSessions()).toEqual([]);
  });

  it('silently swallows errors on setActiveSessions', () => {
    vi.spyOn(mockLocalStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setActiveSessions([{ sessionId: 's1', folderPath: '/p' }])).not.toThrow();
  });

  it('empties the active-session list on clearActiveSessions', () => {
    setActiveSessions([
      { sessionId: 's1', folderPath: '/home/user/project-a' },
      { sessionId: 's2', folderPath: '/home/user/project-b' },
    ]);

    clearActiveSessions();

    expect(getActiveSessions()).toEqual([]);
    expect(mockLocalStorage.getItem('pimote:activeSessions')).toBeNull();
  });
});

describe('Persistence — Session drafts', () => {
  it('round-trips text through per-tab sessionStorage', () => {
    setSessionDraft('s1', { text: 'unsent prompt' });

    expect(getSessionDraft('s1')).toEqual({ text: 'unsent prompt' });
    expect(mockLocalStorage.getItem('pimote:sessionDrafts')).toBeNull();
  });

  it('keeps drafts isolated by session id and user profile', () => {
    setSessionDraft('s1', { text: 'first' });
    setUser('other');

    expect(getSessionDraft('s2')).toEqual({ text: '' });
    expect(getSessionDraft('s1')).toEqual({ text: '' });
  });

  it('clears one session draft without touching another', () => {
    setSessionDraft('s1', { text: 'first' });
    setSessionDraft('s2', { text: 'second' });

    clearSessionDraft('s1');

    expect(getSessionDraft('s1')).toEqual({ text: '' });
    expect(getSessionDraft('s2')).toEqual({ text: 'second' });
  });
});

describe('Persistence — Sidebar Preferences', () => {
  it('defaults showArchived to false', () => {
    expect(getShowArchived()).toBe(false);
  });

  it('round-trips showArchived through localStorage', () => {
    setShowArchived(true);
    expect(getShowArchived()).toBe(true);
    setShowArchived(false);
    expect(getShowArchived()).toBe(false);
  });

  it('defaults swipe hint shown to false', () => {
    expect(getSessionPillSwipeHintShown()).toBe(false);
  });

  it('round-trips swipe hint state through localStorage', () => {
    setSessionPillSwipeHintShown(true);
    expect(getSessionPillSwipeHintShown()).toBe(true);
    setSessionPillSwipeHintShown(false);
    expect(getSessionPillSwipeHintShown()).toBe(false);
  });
});
