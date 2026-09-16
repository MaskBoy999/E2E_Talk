// relay-encode-worker.js
// Off-main-thread JPEG encoder for server-relayed voice video frames.
//
// The main thread draws the source frame onto a canvas and hands us an
// ImageBitmap; we draw it on an OffscreenCanvas and encode it there, then send
// the raw bytes back (transferred). Keeping the encode off the main thread is
// what stops two simultaneous relay streams (camera + screen) from starving
// each other and the audio-relay poll.
//
// Message in:  { id, bitmap: ImageBitmap, isA: bool, quality: 0..1 }
// Message out: { id, buffer: ArrayBuffer, size, isA }  (buffer transferred)
//              { id, isA, error: string }
var canvas = null;
var ctx = null;

self.onmessage = function (e) {
    var data = e.data || {};
    var bmp = data.bitmap;
    if (!bmp) return;
    var isA = !!data.isA;
    var quality = typeof data.quality === 'number' ? data.quality : 0.6;
    try {
        var w = bmp.width;
        var h = bmp.height;
        if (!w || !h) {
            try { bmp.close(); } catch (_) {}
            self.postMessage({ id: data.id, isA: isA, error: 'empty bitmap' });
            return;
        }
        if (!canvas || canvas.width !== w || canvas.height !== h) {
            canvas = new OffscreenCanvas(w, h);
            ctx = canvas.getContext('2d');
        }
        ctx.drawImage(bmp, 0, 0, w, h);
        try { bmp.close(); } catch (_) {}
        canvas.convertToBlob({ type: 'image/jpeg', quality: quality }).then(function (blob) {
            if (!blob) {
                self.postMessage({ id: data.id, isA: isA, error: 'no blob' });
                return;
            }
            return blob.arrayBuffer().then(function (buf) {
                self.postMessage({ id: data.id, isA: isA, buffer: buf, size: blob.size }, [buf]);
            });
        }).catch(function (err) {
            self.postMessage({ id: data.id, isA: isA, error: String((err && err.message) || err) });
        });
    } catch (err) {
        try { bmp.close(); } catch (_) {}
        self.postMessage({ id: data.id, isA: isA, error: String((err && err.message) || err) });
    }
};
