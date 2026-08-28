import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateAvailableEvent, UpdateStatus } from '@pimote/shared';

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

const { UpdateStore } = await import('./update.svelte.js');

const status: UpdateStatus = {
  currentVersion: '1.0.0',
  latestVersion: '1.2.0',
  releaseUrl: 'https://github.com/alennartz/pimote/releases/tag/pimote-v1.2.0',
};
const event: UpdateAvailableEvent = { type: 'update_available', ...status };

beforeEach(() => {
  values = new Map();
});

describe('UpdateStore', () => {
  it('stores the server-provided status and exposes both banner and marker', () => {
    const store = new UpdateStore();

    store.handleEvent(event);

    expect(store.status).toEqual(status);
    expect(store.showBanner).toBe(true);
    expect(store.showMarker).toBe(true);
  });

  it('dismisses the banner for the current latest version while retaining the ambient marker', () => {
    const store = new UpdateStore();
    store.handleEvent(event);

    store.dismiss();

    expect(store.showBanner).toBe(false);
    expect(store.showMarker).toBe(true);
  });

  it('raises the banner again when a newer release arrives after an older dismissal', () => {
    const store = new UpdateStore();
    store.handleEvent(event);
    store.dismiss();

    store.handleEvent({
      type: 'update_available',
      currentVersion: '1.0.0',
      latestVersion: '1.3.0',
      releaseUrl: 'https://github.com/alennartz/pimote/releases/tag/pimote-v1.3.0',
    });

    expect(store.status?.latestVersion).toBe('1.3.0');
    expect(store.showBanner).toBe(true);
    expect(store.showMarker).toBe(true);
  });

  it('keeps the marker visible after dismissal because it ignores dismissal state', () => {
    const store = new UpdateStore();
    store.handleEvent(event);
    store.dismiss();

    expect(store.showMarker).toBe(true);
  });

  it('uses the persisted dismissal when a fresh store is constructed after reload', () => {
    const first = new UpdateStore();
    first.handleEvent(event);
    first.dismiss();

    const reloaded = new UpdateStore();
    reloaded.handleEvent(event);

    expect(reloaded.showBanner).toBe(false);
    expect(reloaded.showMarker).toBe(true);
  });
});
