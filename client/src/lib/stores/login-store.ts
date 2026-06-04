// Global `LoginStore` instance + `login_step` event routing.
//
// Instantiates a single LoginStore backed by the real pimote WS connection and
// the session registry (for the viewed-session model re-pull), and subscribes
// it to incoming `login_step` events. Mirrors `voice-call-store.ts`.

import type { PimoteEvent } from '@pimote/shared';
import { LoginStore, type LoginStoreSeams } from './login.svelte.js';
import { connection } from './connection.svelte.js';
import { sessionRegistry } from './session-registry.svelte.js';

export const loginStore = new LoginStore({
  sendCommand: ((cmd) => connection.send(cmd)) as LoginStoreSeams['sendCommand'],
  getViewedSessionId: () => sessionRegistry.viewedSessionId,
});

// Subscribe as soon as this module is imported. The listener is retained for
// the lifetime of the app.
connection.onEvent((event: PimoteEvent) => {
  if (event.type === 'login_step') {
    loginStore.handleStep(event.step);
  }
});
