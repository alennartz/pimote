import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { PanelHandle } from './types.js';

/** Tracks active state per key so re-detection deactivates the old handle. */
const handles = new Map<string, { active: boolean }>();

/**
 * Detect whether running inside pimote. Returns a scoped handle for pushing
 * card data, or null if not in pimote.
 *
 * Each key gets an independent namespace — cards from different keys don't
 * interfere. Calling detect() again with the same key deactivates the
 * previous handle (its methods become no-ops) and returns a new one.
 */
export function detect(pi: ExtensionAPI, key: string): PanelHandle | null {
  // Synchronous detection round-trip
  let detected = false;
  const unsub = pi.events.on('pimote:detect:response', () => {
    detected = true;
  });
  pi.events.emit('pimote:detect:request', {});
  unsub();

  if (!detected) return null;

  // Deactivate previous handle for this key
  const prev = handles.get(key);
  if (prev) prev.active = false;

  // Create new handle state
  const state = { active: true };
  handles.set(key, state);

  return {
    updateCards(cards) {
      if (!state.active) return;
      pi.events.emit('pimote:panels', { type: 'cards', namespace: key, cards });
    },
    clear() {
      if (!state.active) return;
      pi.events.emit('pimote:panels', { type: 'clear', namespace: key });
    },
  };
}
