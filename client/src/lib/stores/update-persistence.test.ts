import { beforeEach, describe, expect, it, vi } from 'vitest';

let values = new Map<string, string>();
const mockLocalStorage: Storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, String(value));
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => {
    values.clear();
  },
  get length() {
    return values.size;
  },
  key: (index: number) => [...values.keys()][index] ?? null,
};

vi.stubGlobal('localStorage', mockLocalStorage);

const { getDismissedUpdateVersion, setDismissedUpdateVersion } = await import('./persistence.js');

describe('Persistence — dismissed update version', () => {
  beforeEach(() => {
    values = new Map();
  });

  it('returns null when no update version has been dismissed', () => {
    expect(getDismissedUpdateVersion()).toBeNull();
  });

  it('round-trips the dismissed version through localStorage', () => {
    setDismissedUpdateVersion('1.2.0');

    expect(getDismissedUpdateVersion()).toBe('1.2.0');
  });

  it('overwrites an older dismissed version with the latest dismissal', () => {
    setDismissedUpdateVersion('1.1.0');
    setDismissedUpdateVersion('1.2.0');

    expect(getDismissedUpdateVersion()).toBe('1.2.0');
  });

  it('stores the version under the version-keyed persistence entry', () => {
    setDismissedUpdateVersion('1.2.0');

    expect(mockLocalStorage.getItem('pimote:dismissedUpdateVersion')).toBe('1.2.0');
  });

  it('returns null when localStorage cannot be read', () => {
    vi.spyOn(mockLocalStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(getDismissedUpdateVersion()).toBeNull();
  });

  it('silently swallows errors when localStorage cannot be written', () => {
    vi.spyOn(mockLocalStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => setDismissedUpdateVersion('1.2.0')).not.toThrow();
  });
});
