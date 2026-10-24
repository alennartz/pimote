import type { Card } from '@pimote/shared';

/**
 * Reactive panel store for card data received from the server.
 * Receives panel_update events and exposes the current card list.
 */
export class PanelStore {
  cards: Card[] = $state([]);

  /** Desktop sidepane visibility. Cards stay in the store while collapsed. */
  collapsed: boolean = $state(false);

  get hasCards(): boolean {
    return this.cards.length > 0;
  }

  /** Replace the card list with new data from a panel_update event. Opens a collapsed pane when cards arrive for an empty list. */
  handlePanelUpdate(cards: Card[]): void {
    const hadCards = this.cards.length > 0;
    this.cards = cards;
    if (!hadCards && cards.length > 0) this.collapsed = false;
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
  }

  /** Clear all cards (e.g., when active session changes). */
  reset(): void {
    this.cards = [];
  }
}

export const panelStore = new PanelStore();
