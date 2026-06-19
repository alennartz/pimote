export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Abstraction for the underlying push delivery mechanism (web-push in production)
export interface PushSender {
  sendNotification(subscription: PushSubscriptionRecord, payload: string): Promise<{ statusCode: number }>;
}

// Abstraction for subscription persistence (JSON file in production)
export interface SubscriptionStore {
  load(): Promise<PushSubscriptionRecord[]>;
  save(subscriptions: PushSubscriptionRecord[]): Promise<void>;
}

export interface PushNotificationPayload {
  projectName: string;
  folderPath: string;
  sessionId: string;
  sessionName?: string;
  firstMessage?: string;
  reason: 'idle' | 'interaction';
  // For idle:
  lastAgentMessage?: string;
  // For interaction:
  interaction?: {
    method: string; // 'select' | 'confirm' | 'input' | 'editor'
    title: string;
    options?: string[];
    message?: string; // for confirm
  };
}

export class PushNotificationService {
  private subscriptions: PushSubscriptionRecord[] = [];
  private suppressionPredicate?: (sessionId: string) => boolean;

  constructor(
    private readonly sender: PushSender,
    private readonly store: SubscriptionStore,
  ) {}

  /** Install a predicate that suppresses notifications for a given session.
   *  Used to silence pushes while a voice call owns the session — pushes
   *  resume automatically once the predicate stops returning true (call
   *  hangs up). Pass `undefined` to clear. */
  setSuppressionPredicate(predicate: ((sessionId: string) => boolean) | undefined): void {
    this.suppressionPredicate = predicate;
  }

  /** Load subscriptions from store on startup */
  async initialize(): Promise<void> {
    this.subscriptions = await this.store.load();
  }

  /** Store a new push subscription (or update if endpoint matches) */
  async addSubscription(subscription: PushSubscriptionRecord): Promise<void> {
    const idx = this.subscriptions.findIndex((s) => s.endpoint === subscription.endpoint);
    if (idx !== -1) {
      this.subscriptions[idx] = subscription;
    } else {
      this.subscriptions.push(subscription);
    }
    await this.store.save(this.subscriptions);
  }

  /** Remove a subscription by endpoint */
  async removeSubscription(endpoint: string): Promise<void> {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) {
      await this.store.save(this.subscriptions);
    }
  }

  /** Get all current subscriptions */
  getSubscriptions(): PushSubscriptionRecord[] {
    return [...this.subscriptions];
  }

  /** Send push notification to all subscriptions */
  async notify(payload: PushNotificationPayload): Promise<void> {
    if (this.suppressionPredicate?.(payload.sessionId)) {
      return;
    }
    const payloadStr = JSON.stringify(payload);

    // Snapshot deliberately: `this.subscriptions` is reassigned by add/remove,
    // and we hold this list across awaits. Fan out in parallel rather than
    // serializing behind the slowest endpoint.
    const subs = this.subscriptions;
    const results = await Promise.allSettled(subs.map((sub) => this.sender.sendNotification(sub, payloadStr)));

    const expired = new Set<string>();
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        // 404 Not Found and 410 Gone both mean the subscription is dead.
        if (result.value.statusCode === 404 || result.value.statusCode === 410) {
          expired.add(subs[i].endpoint);
        }
      } else {
        console.warn('[PushNotificationService] Failed to send notification:', (result.reason as Error)?.message ?? result.reason);
      }
    });

    if (expired.size > 0) {
      // Prune against the CURRENT array (which may have changed during the
      // awaits), removing only the endpoints we just found dead.
      this.subscriptions = this.subscriptions.filter((s) => !expired.has(s.endpoint));
      await this.store.save(this.subscriptions);
    }
  }
}
