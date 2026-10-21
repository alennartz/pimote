/**
 * Tracks which client submitted each message in a session's pi queues.
 *
 * Pi keeps bare strings. It removes a consumed message by the first entry
 * whose text matches (`indexOf` in pi's agent session). This ledger removes
 * entries the same way, so it stays aligned with pi's queue order.
 */

export const QUEUE_KINDS = ['steering', 'followUp'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** Queued message texts, in pi's queue order, per queue kind. */
export interface QueueTexts {
  steering: string[];
  followUp: string[];
}

export interface OwnedEntry {
  /** Submitting client, or undefined for input the server queues itself (voice, extensions). */
  clientId: string | undefined;
  text: string;
}

export type QueueOwners = Record<QueueKind, OwnedEntry[]>;

/** One client submission that pi may still queue. Returned by {@link QueueOwnership.intend}. */
export interface Intent {
  kind: QueueKind;
  clientId: string;
  text: string;
}

function takeFirst<T>(items: T[], matches: (item: T) => boolean): T | undefined {
  const index = items.findIndex(matches);
  return index === -1 ? undefined : items.splice(index, 1)[0];
}

export class QueueOwnership {
  private owners: QueueOwners = { steering: [], followUp: [] };
  /** Submissions the server made that pi has not yet reported as queued. */
  private intents: Intent[] = [];

  /** Record a client submission before pi queues it. Cancel the returned
   *  intent when pi reports any outcome other than `queued`. */
  intend(kind: QueueKind, clientId: string, text: string): Intent {
    const intent: Intent = { kind, clientId, text };
    this.intents.push(intent);
    return intent;
  }

  /** Drop one submission that pi did not queue (started, handled, or rejected). */
  cancel(intent: Intent): void {
    this.intents = this.intents.filter((candidate) => candidate !== intent);
  }

  /** Update the ledger from a `queue_update` snapshot of pi's queue. */
  syncFromPi(kind: QueueKind, texts: readonly string[]): void {
    const budget = new Map<string, number>();
    for (const text of texts) budget.set(text, (budget.get(text) ?? 0) + 1);

    // Pi removes a consumed text at its first occurrence. Walk from the end so
    // the earliest entries of each text drop first.
    const survivors: OwnedEntry[] = [];
    for (const entry of [...this.owners[kind]].reverse()) {
      const count = budget.get(entry.text) ?? 0;
      if (count === 0) continue;
      budget.set(entry.text, count - 1);
      survivors.push(entry);
    }
    survivors.reverse();

    // Pi appends new messages at the end of its queue. Pi queues the text
    // after input handlers and skill or template expansion, so an exact match
    // can fail; fall back to the oldest submission of the same kind.
    const additions = texts.slice(survivors.length).map((text): OwnedEntry => {
      const intent = takeFirst(this.intents, (candidate) => candidate.kind === kind && candidate.text === text) ?? takeFirst(this.intents, (candidate) => candidate.kind === kind);
      return { clientId: intent?.clientId, text };
    });
    this.owners[kind] = [...survivors, ...additions];
  }

  /** Drop submissions that pi never queued, such as input a handler consumed. */
  clearIntents(): void {
    this.intents = [];
  }

  /** Copy of the current owners. Read it before pi clears its queue. */
  snapshot(): QueueOwners {
    return { steering: [...this.owners.steering], followUp: [...this.owners.followUp] };
  }
}

/**
 * Group texts that pi drained from its queue by the client that submitted them.
 * Each drained text takes the first unclaimed ledger entry with the same text,
 * as pi removes by first match. Untagged or unmatched texts go to
 * `fallbackClientId`.
 */
export function attributeDrained(owners: QueueOwners, drained: QueueTexts, fallbackClientId: string): Map<string, QueueTexts> {
  const groups = new Map<string, QueueTexts>();
  for (const kind of QUEUE_KINDS) {
    const entries = [...owners[kind]];
    for (const text of drained[kind]) {
      const entry = takeFirst(entries, (candidate) => candidate.text === text);
      const clientId = entry?.clientId ?? fallbackClientId;
      const group = groups.get(clientId) ?? { steering: [], followUp: [] };
      group[kind].push(text);
      groups.set(clientId, group);
    }
  }
  return groups;
}
