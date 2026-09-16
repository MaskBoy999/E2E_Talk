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

// ---- DEBUG (one-sided audio): frame timing + drop counters ----------------
// Aggregate across ALL transforms on this worker. Every 1s we post a stats
// message to the page (the app's e2eeWorker.onmessage collects it into
// window.__voiceE2eeStats when window.__enableVoiceAudioDebug is set). This
// tells us whether audio frames are being delayed/dropped in the crypto
// transforms — a stall here delays frames past the receiver's jitter-buffer
// playout deadline, which shows up as concealment (audible stops) on ONE side.
const __dbg = { enc: 0, dec: 0, encDrop: 0, decDrop: 0, short: 0, encMs: 0, decMs: 0, encMaxMs: 0, decMaxMs: 0, lastTs: 0,
    transforms: 0, encTransforms: 0, decTransforms: 0, decNoKey: 0, decEnter: 0, encNoKey: 0,
    encV: 0, decV: 0, decVEnter: 0, encA: 0, decA: 0, decAEnter: 0 };
setInterval(() => {
    try {
        self.postMessage({ type: 'voice-e2ee-stats', stats: {
            enc: __dbg.enc, dec: __dbg.dec, encDrop: __dbg.encDrop, decDrop: __dbg.decDrop,
            short: __dbg.short, encAvgMs: __dbg.enc ? __dbg.encMs / __dbg.enc : 0, decAvgMs: __dbg.dec ? __dbg.decMs / __dbg.dec : 0,
            encMaxMs: __dbg.encMaxMs, decMaxMs: __dbg.decMaxMs,
            transforms: __dbg.transforms, encTransforms: __dbg.encTransforms, decTransforms: __dbg.decTransforms,
            decNoKey: __dbg.decNoKey, decEnter: __dbg.decEnter, encNoKey: __dbg.encNoKey,
            encV: __dbg.encV, decV: __dbg.decV, decVEnter: __dbg.decVEnter, encA: __dbg.encA, decA: __dbg.decA, decAEnter: __dbg.decAEnter,
        } });
    } catch (_) {}
}, 1000);

// Live transformer registry so the page can ask every VIDEO SENDER to emit a
// keyframe right now — used on mobile wake, where every receiver's decoder
// lost its reference frames while the phone slept and needs a clean keyframe
// to resync (the periodic 2.5s timer also covers this, but an explicit kick
// right after wake makes recovery immediate instead of up-to-2.5s-late).
const liveTransformers = new Set();
self.onmessage = (e) => {
    if (e.data && e.data.type === 'generate-keyframes') {
        liveTransformers.forEach((t) => {
            try {
                if (typeof t.generateKeyFrame === 'function') {
                    const p = t.generateKeyFrame();
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                }
            } catch (_) {}
        });
    }
};

addEventListener('rtctransform', (event) => {
    const transformer = event.transformer;
    const options = transformer.options || {};
    const operation = options.operation || 'encrypt';
    const keyB64 = options.key || '';
    __dbg.transforms++;
    if (operation === 'encrypt') __dbg.encTransforms++;
    else __dbg.decTransforms++;
    liveTransformers.add(transformer);

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
            // Video senders only: force a keyframe every ~2.5s. A receiver
            // that attaches mid-stream (room key arriving late, renegotiation,
            // decoder restart) has NOTHING to decode until the next keyframe
            // — every delta frame decrypts fine but can't be rendered, so the
            // tile sits black/artifacted. Browsers' own keyframe cadence is
            // low for static content, so this guarantees fast recovery.
            // Started lazily on the first VIDEO frame (audio frames have no
            // `type`), so audio-only calls never spin a timer.
            event.transformer._codebuffKfStarted = false;
        },
        async transform(encodedFrame, controller) {
            const t0 = Date.now();
            try {
                if (!myKey) {
                    // No key yet: DROP the frame rather than forwarding
                    // unencrypted bytes to the decoder or server/peers.
                    if (operation === 'decrypt') {
                        if (encodedFrame.type !== undefined) __dbg.decNoKey++;
                    } else {
                        __dbg.encNoKey++;
                    }
                    return; // drop — key will arrive shortly, next frames will encrypt/decrypt
                }
                // Start the video keyframe timer on the first video frame
                // (RTCEncodedVideoFrame has `.type`; audio frames don't).
                if (operation === 'encrypt' && !event.transformer._codebuffKfStarted &&
                    encodedFrame.type !== undefined &&
                    typeof event.transformer.generateKeyFrame === 'function') {
                    event.transformer._codebuffKfStarted = true;
                    event.transformer._codebuffKfTimer = setInterval(() => {
                        try { event.transformer.generateKeyFrame(); } catch (_) {}
                    }, 2500);
                }
                const data = new Uint8Array(encodedFrame.data.byteLength);
                data.set(new Uint8Array(encodedFrame.data));

                // Per-kind counters: the one-sided-audio and black-video bugs
                // both show up as a decrypt transform that STOPS receiving
                // frames — splitting audio vs video isolates which direction
                // died (a video renegotiation can kill the video decrypt while
                // audio keeps flowing, and vice versa).
                const isVideo = encodedFrame.type !== undefined;
                if (operation === 'decrypt') {
                    __dbg.decEnter++;
                    if (isVideo) __dbg.decVEnter++;
                    else __dbg.decAEnter++;
                }

                if (operation === 'encrypt') {
                    const nonce = crypto.getRandomValues(new Uint8Array(12));
                    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
                        { name: 'AES-GCM', iv: nonce }, myKey, data
                    ));
                    const out = new Uint8Array(12 + ciphertext.length);
                    out.set(nonce, 0);
                    out.set(ciphertext, 12);
                    encodedFrame.data = out.buffer;
                    __dbg.enc++;
                    if (isVideo) __dbg.encV++;
                    else __dbg.encA++;
                    const dt = Date.now() - t0;
                    __dbg.encMs += dt;
                    if (dt > __dbg.encMaxMs) __dbg.encMaxMs = dt;
                    controller.enqueue(encodedFrame);
                } else {
                    if (data.length < 13) {
                        // Not our frame format — drop it rather than forwarding
                        // unencrypted bytes to the decoder.
                        __dbg.short++;
                        return;
                    }
                    const nonce = data.slice(0, 12);
                    const ciphertext = data.slice(12);
                    const plain = new Uint8Array(await crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv: nonce }, myKey, ciphertext
                    ));
                    encodedFrame.data = plain.buffer;
                    __dbg.dec++;
                    if (isVideo) __dbg.decV++;
                    else __dbg.decA++;
                    const dt = Date.now() - t0;
                    __dbg.decMs += dt;
                    if (dt > __dbg.decMaxMs) __dbg.decMaxMs = dt;
                    controller.enqueue(encodedFrame);
                }
            } catch (_) {
                // IMPORTANT: never forward a frame we failed to process.
                //  - Decrypt failure: forwarding the ENCRYPTED bytes to the
                //    decoder yields garbage / decode artifacts until the next
                //    keyframe (this was the 'lots of artifacts' bug).
                //  - Encrypt failure: forwarding the PLAINTEXT bytes would leak
                //    the frame in the clear to the server/peers.
                // Dropping the frame is correct in both cases — and on VIDEO
                // decrypt failures we also force a keyframe on the sender:
                // after a phone sleeps/wakes mid-call the sender keeps
                // emitting deltas the receiver cannot resync from, so without
                // this the tile stays artifacted until the next periodic
                // keyframe happens to decode cleanly. generateKeyFrame() on
                // the sender is backpressure-safe (requests are deduped).
                if (operation === 'encrypt') __dbg.encDrop++;
                else {
                    __dbg.decDrop++;
                    if (isVideo && typeof event.transformer.generateKeyFrame === 'function') {
                        try { event.transformer.generateKeyFrame(); } catch (_e) {}
                    }
                }
            }
        },
    });

    const cleanup = () => {
        liveTransformers.delete(transformer);
        if (event.transformer._codebuffKfTimer) {
            clearInterval(event.transformer._codebuffKfTimer);
            event.transformer._codebuffKfTimer = null;
        }
    };
    transformer.readable.pipeThrough(transform).pipeTo(transformer.writable).then(cleanup, cleanup);
});
