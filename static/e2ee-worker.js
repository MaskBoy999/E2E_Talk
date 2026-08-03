// e2ee-worker.js — WebRTC Insertable Streams encryption/decryption.
// Runs inside a Worker. Every RTCRtpScriptTransform created from this worker
// dispatches an `rtctransform` event; the options carry { operation, key }.
//   operation: 'encrypt' (sender) | 'decrypt' (receiver)
//   key:       base64 of the 32-byte AES-256-GCM key (shared room key)
// Frame layout (on the wire): [12-byte nonce][AES-GCM ciphertext]
// The SFU/server only ever sees the encrypted bytes — it never has the key.

let cryptoKey = null; // CryptoKey cached per transform options key

addEventListener('rtctransform', (event) => {
    const transformer = event.transformer;
    const options = transformer.options || {};
    const operation = options.operation || 'encrypt';
    const keyB64 = options.key || '';

    const transform = new TransformStream({
        async start() {
            if (!keyB64) return;
            const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
            cryptoKey = await crypto.subtle.importKey(
                'raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
            );
        },
        async transform(encodedFrame, controller) {
            try {
                if (!cryptoKey) {
                    controller.enqueue(encodedFrame);
                    return;
                }
                const data = new Uint8Array(encodedFrame.data.byteLength);
                data.set(new Uint8Array(encodedFrame.data));

                if (operation === 'encrypt') {
                    const nonce = crypto.getRandomValues(new Uint8Array(12));
                    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
                        { name: 'AES-GCM', iv: nonce }, cryptoKey, data
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
                        { name: 'AES-GCM', iv: nonce }, cryptoKey, ciphertext
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
