/* PWA: register the service worker.
   Moved out of an inline <script> in index.html so the server's
   Content-Security-Policy no longer needs 'unsafe-inline' for scripts. */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function(reg) {
        // Check for updates every hour
        setInterval(function() { reg.update(); }, 3600000);
    }).catch(function(err) {
        console.warn('SW registration failed:', err);
    });
    // Handle messages from service worker (flush queued messages)
    navigator.serviceWorker.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'flush-queued-message') {
            // Re-send the queued message via WebSocket
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify(event.data.payload)); } catch (_) {}
            }
        } else if (event.data && event.data.type === 'navigate') {
            window.location.href = event.data.url;
        }
    });
}
