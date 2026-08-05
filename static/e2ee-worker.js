// e2ee-worker.js — WebRTC Insertable Streams encryption/decryption.
// Runs inside a Worker. Every RTCRtpScriptTransform created from this worker
// dispatches an `rtctransform` event; the options carry { operation, key }.
//   operation: 'encrypt' (sender) | 'decrypt' (receiver)
//   key:       base64 of the 32-byte AES-256-GCM key (shared room key)
// Frame layout (on the wire): [12-byte nonce][AES-GCM ciphertext]
// The SFU/server only ever sees the encrypted bytes — it never has the key.

// keyCache: keyB64 -> CryptoKey, so every transform gets ITS OWN CryptoKey.
// Each rtctransform creates a new transform stream whose start() imports (or
// reuses) the key for ITS options.key — never a module-level variable that
// later transforms (e.g. after leaving a room and joining another with a
// different key) could clobber, which would silently break every other
// transform's encrypt/decrypt.
const keyCache = new Map();

addEventListener('rtctransform', (event) => {
    const transformer = event.transformer;
    const options = transformer.options || {};
    const operation = options.operation || 'encrypt';
    const keyB64 = options.key || '';

    // Per-transform key: start() runs before any transform() for this stream,
    // so `myKey` is race-free even when many transforms share the worker.
    let myKey = null;

    const transform = new TransformStream({
        async start() {
            if (!keyB64) return;
            let cached = keyCache.get(keyB64);
            if (!cached) {
                const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
                cached = await crypto.subtle.importKey(
                    'raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
                );
                keyCache.set(keyB64, cached);
                // Bound the cache so long-lived tabs that join many rooms
                // don't grow it without limit.
                if (keyCache.size > 32) {
                    const oldest = keyCache.keys().next().value;
                    if (oldest !== undefined) keyCache.delete(oldest);
                }
            }
            myKey = cached;
        },
        async transform(encodedFrame, controller) {
            try {
                if (!myKey) {
                    controller.enqueue(encodedFrame);
                    return;
                }
                const data = new Uint8Array(encodedFrame.data.byteLength);
                data.set(new Uint8Array(encodedFrame.data));

                if (operation === 'encrypt') {
                    const nonce = crypto.getRandomValues(new Uint8Array(12));
                    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
                        { name: 'AES-GCM', iv: nonce }, myKey, data
                    ));
                    const out = new Uint8Array(12 + ciphertext.length);
                    out.set(nonce, 0);
                    out.set(ciphertext, 12);
                    encodedFrame.data = out.buffer;
                } else {
                    if (data.length < 13) {
                        controller.enqueue(encodedFrame);
                        return;
                    }
                    const nonce = data.slice(0, 12);
                    const ciphertext = data.slice(12);
                    const plain = new Uint8Array(await crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv: nonce }, myKey, ciphertext
                    ));
                    encodedFrame.data = plain.buffer;
                }
            } catch (_) {
                // Drop undecryptable frames silently (e.g. a key that doesn't match)
            }
            controller.enqueue(encodedFrame);
        },
    });

    transformer.readable.pipeThrough(transform).pipeTo(transformer.writable).catch(() => {});
});
