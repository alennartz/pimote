import type { Card } from '@pimote/shared';

/**
 * Reactive panel store for card data received from the server.
 * Receives panel_update events and exposes the current card list.
 */
export class PanelStore {
  cards: Card[] = $state([]);

  /** Desktop sidepane visibility. Cards stay in the store while collapsed. */
  collapsed: boolean = $state(false);
  /** The panel host switches to a drawer when its conversation container is narrow. */
  presentation: 'sidebar' | 'drawer' = $state('sidebar');
  /** Drawer visibility is separate from desktop collapse so child views can close it. */
  open: boolean = $state(true);
  containerWidth: number = $state(Number.POSITIVE_INFINITY);

  get isDrawer(): boolean {
    return this.presentation === 'drawer';
  }

  /** Measure the host container, not the viewport. */
  setContainerWidth(width: number): void {
    if (!Number.isFinite(width)) return;
    this.containerWidth = width;
    const presentation = width <= 620 ? 'drawer' : 'sidebar';
    if (presentation === this.presentation) return;
    this.presentation = presentation;
    this.open = presentation === 'sidebar' && !this.collapsed;
  }

  openPanel(): void {
    this.open = true;
  }

  /** Reveal the host for actions that originate outside the panel. */
  revealPanel(): void {
    this.collapsed = false;
    this.open = true;
  }

  closePanel(): void {
    this.open = false;
  }

  togglePanel(): void {
    this.open = !this.open;
  }

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
    if (this.presentation === 'sidebar') this.open = !this.collapsed;
  }

  /** Clear all cards (e.g., when active session changes). */
  reset(): void {
    this.cards = [];
  }
}

export const panelStore = new PanelStore();
