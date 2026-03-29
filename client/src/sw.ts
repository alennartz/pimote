/// <reference lib="webworker" />

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

// Activate immediately on install
self.skipWaiting();
clientsClaim();

// Precache assets — vite-plugin-pwa injects the manifest into self.__WB_MANIFEST
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigation fallback — serve precached index.html for all navigation requests
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

// --- Push notifications ---

self.addEventListener('push', (event) => {
	let data;
	try {
		data = event.data?.json();
	} catch {
		data = { projectName: 'Pimote', sessionId: '' };
	}

	const title = data.projectName || 'Pimote';
	const body = data.firstMessage
		? `Session finished: ${data.firstMessage}`
		: 'Session has finished working';

	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			const focused = clients.find((c) => c.focused);
			if (focused) {
				// In-app: post message to client for in-app handling
				focused.postMessage({
					type: 'push_notification',
					title,
					body,
					sessionId: data.sessionId,
				});
			} else {
				// Out-of-app: show OS notification
				return self.registration.showNotification(title, {
					body,
					data: { sessionId: data.sessionId },
					icon: '/icon-192.png',
				});
			}
		}),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: 'window' }).then((clients) => {
			if (clients.length > 0) {
				clients[0].focus();
			} else {
				self.clients.openWindow('/');
			}
		}),
	);
});
