/* MikeOS push handlers — pulled into the generated service worker via
 * workbox `importScripts` (vite.config.ts). The Worker sends an encrypted
 * JSON payload { title, body, url, tag, taskId } (worker/src/push.ts). */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'MikeOS', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'MikeOS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: !!data.taskId, // task reminders stay until dismissed (desktop)
      data: { url: data.url || '/today' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/today', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin) && 'focus' in w) {
          return w.focus().then((f) => (f && 'navigate' in f ? f.navigate(url) : f));
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
