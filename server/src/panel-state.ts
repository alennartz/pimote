import type { Card } from '../../shared/dist/index.js';
import type { PanelMessage } from '@pimote/sdk';

export type { PanelMessage };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCardColor(value: unknown): value is NonNullable<Card['color']> {
  return value === 'accent' || value === 'success' || value === 'warning' || value === 'error' || value === 'muted';
}

function isBodySectionStyle(value: unknown): value is NonNullable<Card['body']>[number]['style'] {
  return value === 'text' || value === 'code' || value === 'secondary';
}

/**
 * Validate a card and copy only the fields in the SDK Card schema.
 *
 * This function reads untrusted values inside the caller's try/catch. It uses
 * indexed array access instead of iterators, and never retains an extension
 * object or array reference.
 */
function snapshotCard(value: unknown): Card | null {
  try {
    if (!isRecord(value)) return null;

    const id = value.id;
    if (typeof id !== 'string') return null;

    const header = value.header;
    if (!isRecord(header)) return null;
    const title = header.title;
    if (typeof title !== 'string') return null;

    const snapshot: Card = { id, header: { title } };

    const color = value.color;
    if (color !== undefined) {
      if (!isCardColor(color)) return null;
      snapshot.color = color;
    }

    const tag = header.tag;
    if (tag !== undefined) {
      if (typeof tag !== 'string') return null;
      snapshot.header.tag = tag;
    }

    const body = value.body;
    if (body !== undefined) {
      if (!Array.isArray(body)) return null;
      const bodySnapshot: NonNullable<Card['body']> = [];
      for (let index = 0; index < body.length; index++) {
        const section = body[index];
        if (!isRecord(section)) return null;
        const content = section.content;
        const style = section.style;
        if (typeof content !== 'string' || !isBodySectionStyle(style)) return null;
        bodySnapshot.push({ content, style });
      }
      snapshot.body = bodySnapshot;
    }

    const footer = value.footer;
    if (footer !== undefined) {
      if (!Array.isArray(footer)) return null;
      const footerSnapshot: string[] = [];
      for (let index = 0; index < footer.length; index++) {
        const line = footer[index];
        if (typeof line !== 'string') return null;
        footerSnapshot.push(line);
      }
      snapshot.footer = footerSnapshot;
    }

    const href = value.href;
    if (href !== undefined) {
      if (typeof href !== 'string') return null;
      snapshot.href = href;
    }

    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Process an untrusted panel bus message and update the panel state map.
 * - 'cards' messages replace the card list for that namespace.
 * - 'clear' messages remove the namespace entirely.
 *
 * A message is accepted only after all of its cards pass validation and are
 * copied into server-owned snapshots. Invalid messages leave existing state
 * unchanged.
 */
export function applyPanelMessage(panelState: Map<string, Card[]>, message: unknown): boolean {
  try {
    if (!isRecord(message)) return false;

    const type = message.type;
    const namespace = message.namespace;
    if (typeof namespace !== 'string') return false;

    if (type === 'clear') {
      panelState.delete(namespace);
      return true;
    }

    if (type !== 'cards') return false;
    const cards = message.cards;
    if (!Array.isArray(cards)) return false;

    const snapshots: Card[] = [];
    for (let index = 0; index < cards.length; index++) {
      const snapshot = snapshotCard(cards[index]);
      if (!snapshot) return false;
      snapshots.push(snapshot);
    }

    panelState.set(namespace, snapshots);
    return true;
  } catch {
    return false;
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
