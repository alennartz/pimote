/// <reference lib="webworker" />

// `renotify` is part of the Notification spec but missing from TypeScript's DOM lib.
// Augment NotificationOptions so showNotification() accepts it without error.
declare global {
  interface NotificationOptions {
    renotify?: boolean;
  }
}

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

// --- Web Share Target ---
// When the OS shares files to Pimote, it POSTs to /_share.
// We intercept here, stash images in a temporary cache, and either
// post them to an existing client or redirect so the app picks them up on load.

const SHARE_CACHE = 'pimote-share-target';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/_share' && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
  }
});

async function handleShareTarget(request: Request): Promise<Response> {
  const formData = await request.formData();
  const files = formData.getAll('images') as File[];

  if (files.length === 0) {
    return Response.redirect('/', 303);
  }

  // Try to post directly to an already-open client
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length > 0) {
    // Convert files to base64 data URIs in the SW
    const dataUris: string[] = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      dataUris.push(`data:${file.type};base64,${base64}`);
    }

    const target = clients.find((c) => c.focused) ?? clients[0];
    target.postMessage({ type: 'share_images', images: dataUris });

    // Focus the existing client instead of opening a new tab
    if ('focus' in target) {
      await (target as WindowClient).focus();
    }
    // Return a minimal response — the OS will close the share sheet.
    // A redirect here would open a duplicate tab on some browsers.
    return new Response('', { status: 204 });
  }

  // No client open — stash in cache and redirect to the app
  const cache = await caches.open(SHARE_CACHE);
  const dataUris: string[] = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    dataUris.push(`data:${file.type};base64,${base64}`);
  }
  await cache.put(
    '/_share/pending',
    new Response(JSON.stringify(dataUris), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  return Response.redirect('/?share=pending', 303);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

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
          badge: '/pwa/badge-96.png',
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
