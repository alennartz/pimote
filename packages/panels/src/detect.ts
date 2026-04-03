import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { PanelHandle } from './types.js';

/**
 * Detect whether running inside pimote. Returns a scoped handle for pushing
 * card data, or null if not in pimote.
 *
 * Each key gets an independent namespace — cards from different keys don't
 * interfere. Calling detect() again with the same key deactivates the
 * previous handle (its methods become no-ops) and returns a new one.
 */
export function detect(_pi: ExtensionAPI, _key: string): PanelHandle | null {
  throw new Error('not implemented');
}
