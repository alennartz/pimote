import type { Card } from '@pimote/shared';

/** Panel EventBus message shapes (mirrors @pimote/panels PanelMessage). */
export type PanelBusMessage = { type: 'cards'; namespace: string; cards: Card[] } | { type: 'clear'; namespace: string };

/**
 * Process a panel bus message and update the panel state map.
 * - 'cards' messages replace the card list for that namespace.
 * - 'clear' messages remove the namespace entirely.
 */
export function applyPanelMessage(_panelState: Map<string, Card[]>, _message: PanelBusMessage): void {
  throw new Error('not implemented');
}

/**
 * Merge all namespaces into a flat card list for sending to the client.
 * Order: namespaces in insertion order, cards within each namespace in array order.
 */
export function getMergedPanelCards(_panelState: Map<string, Card[]>): Card[] {
  throw new Error('not implemented');
}
