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

  constructor(
    private readonly sender: PushSender,
    private readonly store: SubscriptionStore,
  ) {}

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
    const expiredEndpoints: string[] = [];
    const payloadStr = JSON.stringify(payload);

    for (const sub of this.subscriptions) {
      try {
        const result = await this.sender.sendNotification(sub, payloadStr);
        if (result.statusCode === 410) {
          expiredEndpoints.push(sub.endpoint);
        }
      } catch (err) {
        console.warn('[PushNotificationService] Failed to send notification:', (err as Error).message ?? err);
      }
    }

    if (expiredEndpoints.length > 0) {
      this.subscriptions = this.subscriptions.filter((s) => !expiredEndpoints.includes(s.endpoint));
      await this.store.save(this.subscriptions);
    }
  }
}
