export type CardColor = 'accent' | 'success' | 'warning' | 'error' | 'muted';
export type BodySectionStyle = 'text' | 'code' | 'secondary';

export interface BodySection {
  content: string;
  style: BodySectionStyle;
}

export interface Card {
  id: string;
  color?: CardColor;
  header: {
    title: string;
    tag?: string;
  };
  body?: BodySection[];
  footer?: string[];
}

export interface PanelHandle {
  /** Replace this handle's cards. Full snapshot — previous cards for this namespace are discarded. */
  updateCards(cards: Card[]): void;
  /** Remove all cards for this namespace. */
  clear(): void;
}

/** Message shapes emitted on the 'pimote:panels' EventBus channel. */
export type PanelMessage = { type: 'cards'; namespace: string; cards: Card[] } | { type: 'clear'; namespace: string };
