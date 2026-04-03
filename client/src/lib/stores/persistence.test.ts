import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PersistedSession } from './persistence.js';

// ---------------------------------------------------------------------------
// localStorage mock — Node v25 has a built-in localStorage that shadows
// jsdom's, but it's non-functional without --localstorage-file. We provide
// our own Map-backed mock on globalThis to test the persistence module.
// ---------------------------------------------------------------------------

let store: Map<string, string>;
let mockLocalStorage: Storage;

function createMockLocalStorage(): Storage {
  store = new Map();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

beforeEach(() => {
  mockLocalStorage = createMockLocalStorage();
  vi.stubGlobal('localStorage', mockLocalStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Dynamic import to pick up the stubbed localStorage each time.
// The module is pure functions that reference `localStorage` at call time,
// so a static import works fine.
const { getClientId, setClientId, getActiveSessions, setActiveSessions, getViewedSessionId, setViewedSessionId } = await import('./persistence.js');

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

  it('returns null when localStorage.getItem throws', () => {
    vi.spyOn(mockLocalStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(getClientId()).toBeNull();
  });

  it('silently swallows errors on setClientId', () => {
    vi.spyOn(mockLocalStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setClientId('abc')).not.toThrow();
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
});

describe('Persistence — Viewed Session ID', () => {
  it('returns null when no viewedSessionId has been stored', () => {
    expect(getViewedSessionId()).toBeNull();
  });

  it('round-trips a viewedSessionId through set and get', () => {
    setViewedSessionId('s1');
    expect(getViewedSessionId()).toBe('s1');
  });

  it('overwrites a previously stored viewedSessionId', () => {
    setViewedSessionId('s1');
    setViewedSessionId('s2');
    expect(getViewedSessionId()).toBe('s2');
  });

  it('clears the stored value when set to null', () => {
    setViewedSessionId('s1');
    setViewedSessionId(null);
    expect(getViewedSessionId()).toBeNull();
  });

  it('returns null when localStorage.getItem throws', () => {
    vi.spyOn(mockLocalStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(getViewedSessionId()).toBeNull();
  });

  it('silently swallows errors on setViewedSessionId', () => {
    vi.spyOn(mockLocalStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setViewedSessionId('abc')).not.toThrow();
  });

  it('silently swallows errors on setViewedSessionId(null) removeItem', () => {
    vi.spyOn(mockLocalStorage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => setViewedSessionId(null)).not.toThrow();
  });
});
