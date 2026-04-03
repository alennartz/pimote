import type { Card } from '@pimote/shared';

/** Panel EventBus message shapes (mirrors @pimote/panels PanelMessage). */
export type PanelBusMessage = { type: 'cards'; namespace: string; cards: Card[] } | { type: 'clear'; namespace: string };

/**
 * Process a panel bus message and update the panel state map.
 * - 'cards' messages replace the card list for that namespace.
 * - 'clear' messages remove the namespace entirely.
 */
export function applyPanelMessage(panelState: Map<string, Card[]>, message: PanelBusMessage): void {
  if (message.type === 'cards') {
    panelState.set(message.namespace, message.cards);
  } else if (message.type === 'clear') {
    panelState.delete(message.namespace);
  }
}

/**
 * Merge all namespaces into a flat card list for sending to the client.
 * Order: namespaces in insertion order, cards within each namespace in array order.
 * Skips namespaces with empty card arrays.
 * Card IDs are prefixed with the namespace to prevent collisions across extensions.
 */
export function getMergedPanelCards(panelState: Map<string, Card[]>): Card[] {
  const result: Card[] = [];
  for (const [namespace, cards] of panelState.entries()) {
    for (const card of cards) {
      result.push({ ...card, id: `${namespace}:${card.id}` });
    }
  }
  return result;
}
