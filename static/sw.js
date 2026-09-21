// =====================================================================
// sw.js — Service Worker for E2E Chat PWA
//
// Handles:
// 1. Offline caching of static assets (app shell)
// 2. Background sync for queued messages (sends when back online)
// 3. Push notification handling
// =====================================================================

// Bump this whenever static JS changes: assets are served cache-first, so an
// unchanged cache name keeps an OLD voice.js/chat.js alive and code fixes look
// like they "didn't apply".
const CACHE_NAME = 'e2e-chat-v10';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/login.html',
    '/style.css',
    '/chat.js',
    '/voice.js',
    '/relay-encode-worker.js',
    '/relay-tick-worker.js',
    '/crypto.js',
    '/secure-storage.js',
    '/doc-preview.js',
    '/thread_categories_shortcuts.js',
    '/roles.js',
    '/manifest.json',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch: network-first for API calls, cache-first for static assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // API calls: network only (never cache encrypted data)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                // Return a generic offline response for API calls
                return new Response(JSON.stringify({ error: 'Offline' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                });
            })
        );
        return;
    }

    // HTML shells: network-first so deploys land immediately. Caching the
    // app shell cache-first meant a stale index.html (and its old ?v= script
    // URLs) could be served for weeks — code fixes appeared to "not apply".
    if (event.request.mode === 'navigate' || url.pathname === '/index.html' || url.pathname === '/login.html' || url.pathname === '/') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request).then((c) => c || caches.match('/index.html')))
        );
        return;
    }

    // Static assets: cache first, then network
    event.respondWith(
        caches.match(event.request)
            .then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    // Cache successful responses
                    if (response.ok && response.type === 'basic') {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, clone);
                        });
                    }
                    return response;
                });
            })
            .catch(() => {
                // Offline fallback for navigation
                if (event.request.mode === 'navigate') {
                    return caches.match('/index.html');
                }
                return new Response('Offline', { status: 503 });
            })
    );
});

// Background Sync: send queued messages when back online
self.addEventListener('sync', (event) => {
    if (event.tag === 'send-queued-messages') {
        event.waitUntil(sendQueuedMessages());
    }
});

async function sendQueuedMessages() {
    // Open the IndexedDB to get queued messages
    const db = await openDB();
    const tx = db.transaction('message_queue', 'readwrite');
    const store = tx.objectStore('message_queue');
    const request = store.getAll();

    return new Promise((resolve, reject) => {
        request.onsuccess = async () => {
            const messages = request.result;
            for (const msg of messages) {
                try {
                    // Notify the client to send the message
                    const clients = await self.clients.matchAll();
                    clients.forEach((client) => {
                        client.postMessage({
                            type: 'flush-queued-message',
                            messageId: msg.id,
                            payload: msg.payload,
                        });
                    });
                    // Remove from queue
                    store.delete(msg.id);
                } catch (e) {
                    console.warn('Failed to send queued message:', e);
                }
            }
            resolve();
        };
        request.onerror = reject;
    });
}

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('e2e-chat-queue', 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('message_queue')) {
                db.createObjectStore('message_queue', { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Push Notifications
self.addEventListener('push', (event) => {
    if (!event.data) return;

    let data;
    try {
        data = event.data.json();
    } catch (_) {
        data = { title: 'E2E Chat', body: event.data.text() };
    }

    const options = {
        body: data.body || 'New message',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: data.tag || 'e2e-chat',
        data: data.url || '/',
        actions: data.actions || [],
        vibrate: [100, 50, 100],
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'E2E Chat', options)
    );
});

// Notification click: open/focus the app
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clients) => {
                // Focus existing window if open
                for (const client of clients) {
                    if (client.url.includes(self.registration.scope) && 'focus' in client) {
                        client.postMessage({ type: 'navigate', url: url });
                        return client.focus();
                    }
                }
                // Open new window
                return self.clients.openWindow(url);
            })
    );
});
