import type { Card } from '@pimote/shared';

/**
 * Reactive panel store for card data received from the server.
 * Receives panel_update events and exposes the current card list.
 */
export class PanelStore {
  cards: Card[] = $state([]);

  get hasCards(): boolean {
    return this.cards.length > 0;
  }

  /** Replace the card list with new data from a panel_update event. */
  handlePanelUpdate(_cards: Card[]): void {
    throw new Error('not implemented');
  }

  /** Clear all cards (e.g., when active session changes). */
  reset(): void {
    throw new Error('not implemented');
  }
}

export const panelStore = new PanelStore();
