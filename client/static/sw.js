// Service Worker for Pimote push notifications

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
        focused.postMessage({ type: 'push_notification', title, body, sessionId: data.sessionId });
      } else {
        // Out-of-app: show OS notification
        return self.registration.showNotification(title, {
          body,
          data: { sessionId: data.sessionId },
          icon: '/favicon.svg',
        });
      }
    })
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
    })
  );
});
