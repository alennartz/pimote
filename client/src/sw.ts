/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope;

// Activate immediately on install
self.skipWaiting();
clientsClaim();

// No precaching or routing — the app requires a network connection.
// The service worker exists solely for push notifications.
// Workbox injectManifest requires this token to exist; precacheAndRoute is a no-op with an empty manifest.
precacheAndRoute(self.__WB_MANIFEST);

// --- Client focus tracking (Windows workaround) ---
// On desktop Chrome (Windows), WindowClient.focused is unreliable in push
// event handlers — it returns false even when the tab is active and focused.
// The client sends focus_state messages on focus/blur/visibilitychange so the
// SW has an accurate picture. Default to false (show notification) if the SW
// restarts and loses state — that's the safe fallback.
const isWindows = /Windows/.test(self.navigator.userAgent);
let clientHasFocus = false;

self.addEventListener('message', (event) => {
  if (event.data?.type === 'focus_state') {
    clientHasFocus = event.data.hasFocus === true;
  }
});

// --- Push notifications ---

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    data = { projectName: 'Pimote', sessionId: '' };
  }

  const title = data.sessionName || data.firstMessage || data.projectName || 'Pimote';

  let body: string;
  if (data.reason === 'interaction' && data.interaction) {
    const { method, title: interactionTitle, options, message: interactionMessage } = data.interaction;
    if (method === 'select' && options?.length) {
      body = `${interactionTitle}\n${options.map((o: string, i: number) => `${i + 1}. ${o}`).join('\n')}`;
    } else if (method === 'confirm' && interactionMessage) {
      body = `${interactionTitle}: ${interactionMessage}`;
    } else {
      body = interactionTitle;
    }
  } else {
    // idle
    body = data.lastAgentMessage || (data.firstMessage ? `Session idle: ${data.firstMessage}` : 'Session has finished working');
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // On Windows, use the client-reported focus state (client.focused is
      // broken in push handlers on desktop Chrome). On other platforms,
      // use the native client.focused which works correctly.
      const appInFocus = isWindows ? clientHasFocus : clients.some((c) => c.focused);

      if (appInFocus && clients.length > 0) {
        // In-app: post message to client for in-app handling
        const target = clients.find((c) => c.focused) ?? clients[0];
        target.postMessage({
          type: 'push_notification',
          title,
          body,
          sessionId: data.sessionId,
          folderPath: data.folderPath,
          reason: data.reason,
          interaction: data.interaction,
        });
      } else {
        // Out-of-app: show OS notification
        return self.registration.showNotification(title, {
          body,
          data: { sessionId: data.sessionId, folderPath: data.folderPath },
          icon: '/pwa/icon-192.png',
          tag: `pimote-${data.sessionId}`,
          renotify: true,
        });
      }
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const folderPath = event.notification.data?.folderPath;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) {
        const client = clients[0];
        client.focus();
        if (sessionId) {
          client.postMessage({ type: 'notification_click', sessionId, folderPath });
        }
      } else {
        const params = new URLSearchParams();
        if (sessionId) params.set('sessionId', sessionId);
        if (folderPath) params.set('folderPath', folderPath);
        const query = params.toString();
        self.clients.openWindow(query ? `/?${query}` : '/');
      }
    }),
  );
});
