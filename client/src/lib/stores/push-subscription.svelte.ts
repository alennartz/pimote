// Push subscription lifecycle for this device.
//
// The browser owns the subscription. `pushManager.getSubscription()` answers
// whether this device is subscribed, so no local dismissal or cache state is
// kept. `refresh()` is idempotent and runs on app start, on connect, on tab
// visibility, and on a timer.

import { connection } from './connection.svelte.js';

/** What the device needs before it can receive pushes. */
export type PushStatus =
  /** No service worker or PushManager in this browser. */
  | 'unsupported'
  /** Permission is `denied`. Only the browser's site settings can change it. */
  | 'blocked'
  /** Permission is `default`. A user gesture must call `enable()` to prompt. */
  | 'needs-permission'
  /** Permission is granted but no subscription exists and creation failed. */
  | 'needs-subscription'
  /** The device has a live subscription. */
  | 'subscribed';

const RECHECK_INTERVAL_MS = 60_000;

async function fetchVapidPublicKey(): Promise<string> {
  const res = await fetch('/api/vapid-key');
  const body = (await res.json()) as { publicKey?: string };
  return body.publicKey ?? '';
}

/** Create a subscription. Prompts only when permission is still `default`. */
async function createSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  const publicKey = await fetchVapidPublicKey();
  if (!publicKey) {
    throw new Error('Server returned no VAPID key. Push notifications are not configured.');
  }
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
}

async function registerWithServer(subscription: PushSubscription): Promise<void> {
  const sub = subscription.toJSON();
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('Push subscription returned incomplete data.');
  }
  const res = await connection.send({
    type: 'register_push',
    subscription: {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    },
  });
  if (!res.success) throw new Error(res.error ?? 'register_push failed');
}

function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Convert a VAPID key from base64 URL to an ArrayBuffer.
function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer as ArrayBuffer;
}

class PushSubscriptionStore {
  status: PushStatus | null = $state(null);
  error = $state('');
  enabling = $state(false);

  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Run a refresh now, then on a timer and on tab visibility. Returns the stop function. */
  start(): () => void {
    const tick = () => void this.refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tick();
    };
    tick();
    this.timer = setInterval(tick, RECHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }

  /**
   * Bring the device to a subscribed state where possible.
   * Permission granted and no subscription: create one without a prompt.
   * Subscribed and connected: register the endpoint with the server.
   */
  refresh(): Promise<void> {
    // Coalesce overlapping calls onto the run already in flight.
    this.inFlight ??= this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRefresh(): Promise<void> {
    try {
      if (!isPushSupported()) {
        this.status = 'unsupported';
        return;
      }
      const permission = Notification.permission;
      if (permission === 'denied') {
        this.status = 'blocked';
        return;
      }
      if (permission === 'default') {
        this.status = 'needs-permission';
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        try {
          subscription = await createSubscription(reg);
        } catch (err) {
          this.error = (err as Error).message ?? String(err);
          this.status = 'needs-subscription';
          console.error('[pimote] Auto-subscribe failed:', err);
          return;
        }
      }

      this.status = 'subscribed';
      this.error = '';
      if (connection.status === 'connected') {
        try {
          await registerWithServer(subscription);
        } catch (err) {
          console.warn('[pimote] register_push failed, will retry on next refresh:', err);
        }
      }
    } catch (err) {
      this.error = (err as Error).message ?? String(err);
      console.error('[pimote] Push refresh failed:', err);
    }
  }

  /** User gesture: prompt for permission (when `default`) and create the subscription. */
  async enable(): Promise<void> {
    this.error = '';
    this.enabling = true;
    try {
      // Let any refresh already running settle before the subscription changes.
      await this.inFlight;
      const reg = await navigator.serviceWorker.ready;
      await createSubscription(reg);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.error =
        Notification.permission === 'denied'
          ? 'Notification permission was denied. Allow notifications for this site in browser settings.'
          : `Push subscription failed: ${message}`;
      console.error('[pimote] enable() failed:', err);
    } finally {
      this.enabling = false;
      await this.refresh();
    }
  }
}

export const pushSubscription = new PushSubscriptionStore();
