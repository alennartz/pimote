export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Abstraction for the underlying push delivery mechanism (web-push in production)
export interface PushSender {
  sendNotification(
    subscription: PushSubscriptionRecord,
    payload: string,
  ): Promise<{ statusCode: number }>;
}

// Abstraction for subscription persistence (JSON file in production)
export interface SubscriptionStore {
  load(): Promise<PushSubscriptionRecord[]>;
  save(subscriptions: PushSubscriptionRecord[]): Promise<void>;
}

export interface SessionIdlePayload {
  projectName: string;
  firstMessage: string | undefined;
  sessionId: string;
}

export class PushNotificationService {
  constructor(
    private readonly sender: PushSender,
    private readonly store: SubscriptionStore,
  ) {}

  /** Load subscriptions from store on startup */
  async initialize(): Promise<void> {
    throw new Error('Not implemented');
  }

  /** Store a new push subscription (or update if endpoint matches) */
  async addSubscription(subscription: PushSubscriptionRecord): Promise<void> {
    throw new Error('Not implemented');
  }

  /** Remove a subscription by endpoint */
  async removeSubscription(endpoint: string): Promise<void> {
    throw new Error('Not implemented');
  }

  /** Get all current subscriptions */
  getSubscriptions(): PushSubscriptionRecord[] {
    throw new Error('Not implemented');
  }

  /** Send push notification to all subscriptions when a session goes idle */
  async notifySessionIdle(payload: SessionIdlePayload): Promise<void> {
    throw new Error('Not implemented');
  }
}
