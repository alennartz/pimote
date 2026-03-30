import { describe, it, expect } from 'vitest';
import {
  PushNotificationService,
  type PushSubscriptionRecord,
  type PushSender,
  type SubscriptionStore,
  type SessionIdlePayload,
} from './push-notification.js';

// --- In-memory test doubles ---

function makeSubscription(endpoint: string, p256dh = 'key-p256dh', auth = 'key-auth'): PushSubscriptionRecord {
  return { endpoint, keys: { p256dh, auth } };
}

function createMockStore(initial: PushSubscriptionRecord[] = []): SubscriptionStore & { saved: PushSubscriptionRecord[][] } {
  const store = {
    data: [...initial],
    saved: [] as PushSubscriptionRecord[][],
    async load() {
      return [...store.data];
    },
    async save(subscriptions: PushSubscriptionRecord[]) {
      store.data = [...subscriptions];
      store.saved.push([...subscriptions]);
    },
  };
  return store;
}

function createMockSender(
  handler: (sub: PushSubscriptionRecord, payload: string) => { statusCode: number } = () => ({ statusCode: 201 }),
): PushSender & { calls: Array<{ subscription: PushSubscriptionRecord; payload: string }> } {
  const sender = {
    calls: [] as Array<{ subscription: PushSubscriptionRecord; payload: string }>,
    async sendNotification(subscription: PushSubscriptionRecord, payload: string) {
      sender.calls.push({ subscription, payload });
      return handler(subscription, payload);
    },
  };
  return sender;
}

function createService(
  opts: { initial?: PushSubscriptionRecord[]; senderHandler?: (sub: PushSubscriptionRecord, payload: string) => { statusCode: number } } = {},
) {
  const store = createMockStore(opts.initial ?? []);
  const sender = createMockSender(opts.senderHandler);
  const service = new PushNotificationService(sender, store);
  return { service, store, sender };
}

// --- Tests ---

describe('PushNotificationService', () => {
  describe('initialization', () => {
    it('loads subscriptions from the store', async () => {
      const sub = makeSubscription('https://push.example.com/1');
      const { service, store } = createService({ initial: [sub] });

      await service.initialize();

      const subs = service.getSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toBe('https://push.example.com/1');
    });

    it('returns loaded subscriptions after initialize()', async () => {
      const sub1 = makeSubscription('https://push.example.com/1');
      const sub2 = makeSubscription('https://push.example.com/2');
      const { service } = createService({ initial: [sub1, sub2] });

      await service.initialize();

      const subs = service.getSubscriptions();
      expect(subs).toHaveLength(2);
      expect(subs.map((s) => s.endpoint)).toEqual([
        'https://push.example.com/1',
        'https://push.example.com/2',
      ]);
    });
  });

  describe('subscription management', () => {
    it('addSubscription() stores a new subscription and persists via store.save()', async () => {
      const { service, store } = createService();
      await service.initialize();

      const sub = makeSubscription('https://push.example.com/new');
      await service.addSubscription(sub);

      expect(service.getSubscriptions()).toHaveLength(1);
      expect(service.getSubscriptions()[0].endpoint).toBe('https://push.example.com/new');

      // Verify persistence
      expect(store.saved).toHaveLength(1);
      expect(store.saved[0]).toHaveLength(1);
      expect(store.saved[0][0].endpoint).toBe('https://push.example.com/new');
    });

    it('addSubscription() with duplicate endpoint updates the existing entry', async () => {
      const original = makeSubscription('https://push.example.com/1', 'old-p256dh', 'old-auth');
      const { service, store } = createService({ initial: [original] });
      await service.initialize();

      const updated = makeSubscription('https://push.example.com/1', 'new-p256dh', 'new-auth');
      await service.addSubscription(updated);

      const subs = service.getSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0].keys.p256dh).toBe('new-p256dh');
      expect(subs[0].keys.auth).toBe('new-auth');

      // Verify persistence happened
      expect(store.saved).toHaveLength(1);
    });

    it('removeSubscription() removes by endpoint and persists', async () => {
      const sub1 = makeSubscription('https://push.example.com/1');
      const sub2 = makeSubscription('https://push.example.com/2');
      const { service, store } = createService({ initial: [sub1, sub2] });
      await service.initialize();

      await service.removeSubscription('https://push.example.com/1');

      const subs = service.getSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toBe('https://push.example.com/2');

      // Verify persistence
      expect(store.saved).toHaveLength(1);
      expect(store.saved[0]).toHaveLength(1);
    });

    it('removeSubscription() with unknown endpoint does nothing', async () => {
      const sub = makeSubscription('https://push.example.com/1');
      const { service, store } = createService({ initial: [sub] });
      await service.initialize();

      // Should not throw
      await service.removeSubscription('https://push.example.com/nonexistent');

      expect(service.getSubscriptions()).toHaveLength(1);
    });
  });

  describe('notification delivery', () => {
    it('notifySessionIdle() sends push to all subscriptions with correct payload shape', async () => {
      const sub1 = makeSubscription('https://push.example.com/1');
      const sub2 = makeSubscription('https://push.example.com/2');
      const { service, sender } = createService({ initial: [sub1, sub2] });
      await service.initialize();

      const payload: SessionIdlePayload = {
        folderPath: '/home/user/project',
        projectName: 'my-project',
        firstMessage: 'Hello world',
        sessionId: 'session-123',
      };

      await service.notifySessionIdle(payload);

      expect(sender.calls).toHaveLength(2);
      expect(sender.calls[0].subscription.endpoint).toBe('https://push.example.com/1');
      expect(sender.calls[1].subscription.endpoint).toBe('https://push.example.com/2');
    });

    it('notifySessionIdle() with no subscriptions succeeds silently', async () => {
      const { service, sender } = createService();
      await service.initialize();

      const payload: SessionIdlePayload = {
        folderPath: '/home/user/project',
        projectName: 'my-project',
        firstMessage: undefined,
        sessionId: 'session-456',
      };

      // Should not throw
      await service.notifySessionIdle(payload);

      expect(sender.calls).toHaveLength(0);
    });

    it('notifySessionIdle() removes subscriptions that get 410 response (expired) and persists', async () => {
      const sub1 = makeSubscription('https://push.example.com/active');
      const sub2 = makeSubscription('https://push.example.com/expired');
      const { service, store } = createService({
        initial: [sub1, sub2],
        senderHandler: (sub) => {
          if (sub.endpoint === 'https://push.example.com/expired') {
            return { statusCode: 410 };
          }
          return { statusCode: 201 };
        },
      });
      await service.initialize();

      const payload: SessionIdlePayload = {
        folderPath: '/home/user/project',
        projectName: 'test',
        firstMessage: 'hi',
        sessionId: 'session-789',
      };

      await service.notifySessionIdle(payload);

      // Expired subscription should be removed
      const subs = service.getSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0].endpoint).toBe('https://push.example.com/active');

      // Verify the removal was persisted
      const lastSave = store.saved[store.saved.length - 1];
      expect(lastSave).toHaveLength(1);
      expect(lastSave[0].endpoint).toBe('https://push.example.com/active');
    });

    it('notifySessionIdle() handles sender errors gracefully', async () => {
      const sub1 = makeSubscription('https://push.example.com/1');
      const sub2 = makeSubscription('https://push.example.com/2');
      let callCount = 0;
      const { service, sender } = createService({
        initial: [sub1, sub2],
        senderHandler: () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Network error');
          }
          return { statusCode: 201 };
        },
      });
      await service.initialize();

      const payload: SessionIdlePayload = {
        folderPath: '/home/user/project',
        projectName: 'test',
        firstMessage: 'hello',
        sessionId: 'session-err',
      };

      // Should not throw despite first subscription failing
      await service.notifySessionIdle(payload);

      // Should have attempted both subscriptions
      expect(sender.calls).toHaveLength(2);
    });

    it('payload JSON includes projectName, firstMessage, and sessionId', async () => {
      const sub = makeSubscription('https://push.example.com/1');
      const { service, sender } = createService({ initial: [sub] });
      await service.initialize();

      const payload: SessionIdlePayload = {
        folderPath: '/home/user/project',
        projectName: 'pimote',
        firstMessage: 'Fix the bug',
        sessionId: 'session-abc',
      };

      await service.notifySessionIdle(payload);

      expect(sender.calls).toHaveLength(1);
      const sentPayload = JSON.parse(sender.calls[0].payload);
      expect(sentPayload.projectName).toBe('pimote');
      expect(sentPayload.firstMessage).toBe('Fix the bug');
      expect(sentPayload.sessionId).toBe('session-abc');
    });
  });
});
