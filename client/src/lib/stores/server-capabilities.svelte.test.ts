import { describe, expect, it } from 'vitest';
import { ServerCapabilitiesStore } from './server-capabilities.svelte.js';

describe('ServerCapabilitiesStore', () => {
  it('treats voice as disabled until the server advertises otherwise', () => {
    const store = new ServerCapabilitiesStore();
    expect(store.voice).toBe(false);
  });

  it('reflects the server advertisement', () => {
    const store = new ServerCapabilitiesStore();
    store.handleEvent({ type: 'server_capabilities', voice: true });
    expect(store.voice).toBe(true);
    store.handleEvent({ type: 'server_capabilities', voice: false });
    expect(store.voice).toBe(false);
  });
});
