// ServerCapabilitiesStore — what the connected server has enabled.
//
// The server advertises capabilities once per WS connection (see
// server.ts connection open). Unadvertised features are treated as
// disabled, so UI affordances stay hidden until the server confirms them.

import type { ServerCapabilitiesEvent } from '@pimote/shared';
import { connection } from './connection.svelte.js';

export class ServerCapabilitiesStore {
  private advertised: ServerCapabilitiesEvent | null = $state(null);

  /** Voice calling is enabled on the server. False until advertised. */
  get voice(): boolean {
    return this.advertised?.voice ?? false;
  }

  handleEvent(event: ServerCapabilitiesEvent): void {
    this.advertised = event;
  }
}

export const serverCapabilities = new ServerCapabilitiesStore();

// Subscribe as soon as this module is imported. The listener is retained
// for the lifetime of the app.
connection.onEvent((event) => {
  if (event.type === 'server_capabilities') serverCapabilities.handleEvent(event);
});
