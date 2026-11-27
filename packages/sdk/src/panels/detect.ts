import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { PanelHandle } from './types.js';

/** Any object that exposes the shared session event bus, so tests and hosts skip the full ExtensionAPI. */
export type PanelHost = { readonly events: Pick<EventBus, 'on' | 'emit'> };

const handlesByApi = new WeakMap<object, Map<string, { active: boolean }>>();

/**
 * Detect whether running inside pimote. Returns a scoped handle for pushing
 * card data, or null if not in pimote.
 *
 * Each key gets an independent namespace — cards from different keys don't
 * interfere. Calling detect() again with the same key deactivates the
 * previous handle (its methods become no-ops) and returns a new one.
 */
export function detect(pi: PanelHost, key: string): PanelHandle | null {
  let detected = false;
  const unsub = pi.events.on('pimote:detect:response', () => {
    detected = true;
  });
  pi.events.emit('pimote:detect:request', {});
  unsub();

  if (!detected) {
    return null;
  }

  let handles = handlesByApi.get(pi);
  if (!handles) {
    handles = new Map<string, { active: boolean }>();
    handlesByApi.set(pi, handles);
  }
  const prev = handles.get(key);
  if (prev) {
    prev.active = false;
  }

  const state = { active: true };
  handles.set(key, state);

  return {
    updateCards(cards) {
      if (!state.active) {
        return;
      }
      pi.events.emit('pimote:panels', { type: 'cards', namespace: key, cards });
    },
    clear() {
      if (!state.active) {
        return;
      }
      pi.events.emit('pimote:panels', { type: 'clear', namespace: key });
    },
  };
}
