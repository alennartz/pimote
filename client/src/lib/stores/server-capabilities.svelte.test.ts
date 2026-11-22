import { describe, expect, it } from 'vitest';
import { ServerCapabilitiesStore } from './server-capabilities.svelte.js';

describe('ServerCapabilitiesStore', () => {
  it('treats voice as disabled until the server advertises otherwise', () => {
    const store = new ServerCapabilitiesStore();
    expect(store.voice).toBe(false);
  });

  it('reflects the server advertisement', () => {
    const store = new ServerCapabilitiesStore();
    expect(store.apps).toBe(false);
    store.handleEvent({ type: 'server_capabilities', voice: true, apps: true, tagSnippets: [] });
    expect(store.voice).toBe(true);
    expect(store.apps).toBe(true);
    store.handleEvent({ type: 'server_capabilities', voice: false, apps: false, tagSnippets: [] });
    expect(store.voice).toBe(false);
    expect(store.apps).toBe(false);
  });
});
