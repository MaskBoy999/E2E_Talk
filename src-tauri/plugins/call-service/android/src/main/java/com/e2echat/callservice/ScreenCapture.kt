package com.e2echat.callservice

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import app.tauri.plugin.Channel
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

/**
 * Native Android screen capture, because the WebView cannot do it.
 *
 * ## Why this exists at all
 *
 * `navigator.mediaDevices.getDisplayMedia()` is a **Chrome** feature. The
 * Android system WebView that the box renders in has never implemented the
 * Screen Capture API: `navigator.mediaDevices` is there (camera and microphone
 * work), but `getDisplayMedia` is simply `undefined`. That is the literal
 * "screen sharing is not supported on this device" the box used to show, and it
 * is why Discord's Android app captures natively instead of through the
 * WebView.
 *
 * So the capture happens here, in Kotlin, with the platform's own
 * `MediaProjection` API — the same one Chrome and Discord use — and the frames
 * are streamed to the page as JPEG over a Tauri `Channel`. The page paints them
 * onto a canvas and exposes that canvas as a `MediaStream`, so everything
 * downstream (relay encode + AES-GCM per peer, tiles, per-member volume) is
 * completely unchanged and cannot drift from the browser path.
 *
 * ## The rules Android enforces (all of them are load-bearing)
 *
 * * **A foreground service must already be running** with
 *   `foregroundServiceType="mediaProjection"` *before* the projection starts —
 *   API 34+ refuses the projection otherwise. The page claims that type through
 *   `plugin:call-service|updateMedia` before calling in here, and [begin]
 *   translates the resulting `SecurityException` into a sentence that names the
 *   service type rather than surfacing a bare platform string.
 * * **`registerCallback` must be called before `createVirtualDisplay`** — also
 *   an API 34+ requirement, and it throws `SecurityException` rather than
 *   silently misbehaving if you skip it.
 * * **The user must approve every capture** through the system picker. There is
 *   deliberately no way to skip that: the Intent below is the only channel
 *   through which a `MediaProjection` token can be obtained, and it always
 *   shows UI. That is why granting the WebView's permission request (see
 *   `.cargo/config.toml`) can never be enough on its own.
 * * **`Image.close()` on every frame.** The ImageReader buffer queue is tiny
 *   (the second argument below); a dropped close wedges the whole capture.
 * * **A `MediaProjection` token is single-use**, and `createVirtualDisplay` may
 *   be called only once per projection (API 34+ throws otherwise). Every share
 *   therefore asks for a brand-new token; nothing here is reused.
 *
 * ## Stopping must never re-enter (this is what took the app down)
 *
 * `MediaProjection.stop()` invokes the registered `Callback.onStop()`. The
 * callback's job is to tear the capture down — and if that teardown calls
 * `stop()` on the projection again, you get `stop()` → `onStop()` → `stop()` →
 * … with no base case, which ends as a `StackOverflowError` on the capture
 * thread. An `Error` is not catchable in any useful way and takes the whole
 * process with it, so "press Stop sharing" killed the app.
 *
 * The fix is two-fold and both halves matter:
 *   * [stopping] makes teardown **idempotent** (re-entrant calls return
 *     immediately), and
 *   * the callback is **unregistered before** the projection is stopped, so the
 *     platform has nothing left to call back into.
 *
 * [prepare] clears the flag again, because a projection that has been stopped
 * must be able to be replaced by the next share.
 *
 * ## What this deliberately does not do
 *
 * No audio. `MediaProjection` audio capture needs a separate
 * `AudioPlaybackCapture` configuration and only sees other apps' audio when
 * they opt in, and the box already relays the microphone through the existing
 * WebRTC/relay path. Screen *video* is the whole feature; inventing a second
 * audio pipeline here would risk the one that works.
 */
class ScreenCapture(private val activity: Activity) {

    companion object {
        private const val TAG = "E2EScreenCapture"
        private const val QUALITY = 55

        /** Usable formats for the returned `MediaProjection` token. */
        private const val RW_FLAGS = DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR
    }

    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var channel: Channel? = null

    private var width = 0
    private var height = 0
    private var density = 0
    private var targetFps = 10
    private var lastSentAt = 0L
    private var running = false

    /**
     * True while [stop] is tearing things down, and while the capture is
     * stopped. Guards against the `stop()` ↔ `onStop()` recursion described in
     * the class comment, and makes a second Stop from the page a no-op instead
     * of a second `projection.stop()`.
     */
    private var stopping = true

    /**
     * The picker's answer is delivered through Tauri's own activity-result
     * plumbing (`startActivityForResult` + `@ActivityCallback` in
     * CallServicePlugin), **not** through a launcher registered here.
     *
     * WHY THIS IS DELIBERATE, NOT AN OVERSIGHT
     *
     * `ComponentActivity.registerForActivityResult` is only legal while the
     * activity is still *before* STARTED; call it later and it throws
     * `IllegalStateException`. A plugin is constructed well after the activity
     * is running, so registering in this class's initialiser — or anywhere else
     * inside the plugin — is a crash on launch rather than a failed screen
     * share, and it takes the whole app down with it. Tauri's `PluginManager`
     * registers its launchers exactly once from `onActivityCreate`, which is
     * early enough to always be legal, so routing the picker through it removes
     * the entire class of lifecycle bug.
     */

    /**
     * Decide the capture geometry and hand back the system picker's Intent.
     * The caller launches it and routes the result to [begin] or [fail].
     */
    fun prepare(ch: Channel, maxHeight: Int, fps: Int): Intent {
        stop() // never leave an older capture running
        // A fresh share is allowed to start: the previous one (if any) is now
        // fully torn down.
        stopping = false
        channel = ch
        targetFps = if (fps in 1..30) fps else 10
        val mgr = activity.getSystemService(Activity.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val metrics = realMetrics()
        var h = metrics.heightPixels
        var w = metrics.widthPixels
        density = metrics.densityDpi
        // Shrink to the requested height, but never upscale: a small screen
        // must not be blown up just to reach maxHeight.
        val cap = if (maxHeight in 120..2160) maxHeight else 480
        if (h > cap) {
            val scale = cap.toDouble() / h.toDouble()
            w = (w * scale).roundToInt()
            h = cap
        }
        // JPEG wants even dimensions; odd ones cost a row of padding.
        width = (w / 2) * 2
        height = (h / 2) * 2
        // Guard the degenerate case: a zero-sized ImageReader is an
        // IllegalArgumentException that would otherwise surface as an
        // unexplained "could not start screen capture".
        if (width < 2 || height < 2) {
            width = 2
            height = 2
        }
        return mgr.createScreenCaptureIntent()
    }

    /** The user approved the picker: start mirroring into the reader. */
    fun begin(resultCode: Int, data: Intent) {
        // A start can arrive after a stop (the user hit Stop sharing while the
        // picker was still open). Doing nothing here is correct: the token the
        // picker just minted is simply discarded, and no projection is leaked
        // because one was never taken.
        if (stopping) {
            Log.i(TAG, "capture was stopped while the picker was open; ignoring the result")
            return
        }
        val mgr = activity.getSystemService(Activity.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = mgr.getMediaProjection(resultCode, data)
            ?: return fail("the system returned no projection token")

        val ht = HandlerThread("e2e-screen-capture").also { it.start() }
        thread = ht
        val h = Handler(ht.looper)
        handler = h

        // Required before createVirtualDisplay on API 34+; the callback is also
        // how we learn the user stopped sharing from the system UI (the "Stop"
        // chip), which must tear the share down in the page too.
        val cb = object : MediaProjection.Callback() {
            override fun onStop() {
                Log.i(TAG, "projection stopped by the system")
                // Tell the page first: stop() quits the capture thread and
                // clears the channel, so this is the last chance to say so.
                post(mapOf("type" to "stopped"))
                stop()
            }
        }
        projectionCallback = cb
        mp.registerCallback(cb, h)
        projection = mp

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        reader.setOnImageAvailableListener({ r ->
            val image = try { r.acquireLatestImage() } catch (_: Exception) { null }
                ?: return@setOnImageAvailableListener
            try {
                onFrame(image)
            } catch (e: Exception) {
                Log.w(TAG, "dropped a frame: ${e.message}")
            } finally {
                try { image.close() } catch (_: Exception) {}
            }
        }, h)

        virtualDisplay = try {
            mp.createVirtualDisplay(
                "e2e-screen",
                width,
                height,
                density,
                RW_FLAGS,
                reader.surface,
                null,
                h
            )
        } catch (e: SecurityException) {
            // The overwhelmingly common cause, and the one worth naming: since
            // Android 14 a projection may only be created while a foreground
            // service with the `mediaProjection` type is running. The page
            // claims that type via `updateMedia` before opening the picker, so
            // reaching here means the service did not accept it.
            reader.close()
            imageReader = null
            unregisterAndStopProjection()
            return fail(
                "Android refused the capture because no foreground service was running with the " +
                    "mediaProjection type. Make sure you are in the call (not just the app) and try again."
            )
        } catch (e: Exception) {
            reader.close()
            imageReader = null
            unregisterAndStopProjection()
            return fail("could not create the virtual display: ${e.message}")
        }

        running = true
        Log.i(TAG, "capturing ${width}x$height @ ${targetFps}fps")
        post(
            mapOf(
                "type" to "started",
                "w" to width,
                "h" to height,
                "fps" to targetFps
            )
        )
    }

    private fun onFrame(image: android.media.Image) {
        if (stopping || !running) return
        val now = System.currentTimeMillis()
        val interval = (1000L / targetFps).coerceAtLeast(1L)
        if (now - lastSentAt < interval) return
        lastSentAt = now

        val plane = image.planes[0]
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width

        // The reader pads each row to `rowStride`, so the bitmap has to be wide
        // enough to take the padding before it can be cropped back.
        val paddedW = width + rowPadding / pixelStride
        if (paddedW <= 0) return
        val padded = Bitmap.createBitmap(paddedW, height, Bitmap.Config.ARGB_8888)
        val frame = try {
            padded.copyPixelsFromBuffer(plane.buffer)
            if (rowPadding == 0) padded else Bitmap.createBitmap(padded, 0, 0, width, height)
        } catch (e: Exception) {
            // A torn buffer is routine during a rotation or the final frame of
            // a stop; it must not take the capture (or the process) with it.
            Log.w(TAG, "could not read a frame: ${e.message}")
            padded.recycle()
            return
        }
        val out = ByteArrayOutputStream(64 * 1024)
        frame.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
        if (frame !== padded) frame.recycle()
        padded.recycle()

        post(
            mapOf(
                "type" to "frame",
                "jpeg" to Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP),
                "w" to width,
                "h" to height
            )
        )
    }

    /** Channels evaluate JS in the page, which must happen on the UI thread. */
    private fun post(payload: Map<String, Any?>) {
        val ch = channel ?: return
        activity.runOnUiThread {
            try {
                ch.sendObject(payload)
            } catch (e: Exception) {
                Log.w(TAG, "could not deliver a capture message: ${e.message}")
            }
        }
    }

    fun fail(message: String) {
        post(mapOf("type" to "error", "message" to message))
        stop()
    }

    /**
     * Tear the capture down. Idempotent and re-entrancy-safe — see the class
     * comment: this is called from the projection's own `onStop()`, from the
     * page's `stopScreenCapture`, and from [prepare] before a new share.
     */
    fun stop() {
        if (stopping) return
        stopping = true
        running = false

        // The callback must be detached BEFORE the projection is stopped,
        // otherwise `stop()` below re-enters `onStop()`. This is the whole
        // reason the app used to die when the share was released.
        unregisterAndStopProjection()

        try { virtualDisplay?.release() } catch (e: Exception) { Log.w(TAG, "release failed: ${e.message}") }
        virtualDisplay = null
        try { imageReader?.close() } catch (e: Exception) { Log.w(TAG, "reader close failed: ${e.message}") }
        imageReader = null
        try { thread?.quitSafely() } catch (e: Exception) { Log.w(TAG, "thread quit failed: ${e.message}") }
        thread = null
        handler = null
        channel = null
    }

    /** Detach the callback, then stop the projection — both best-effort. */
    private fun unregisterAndStopProjection() {
        val mp = projection
        projection = null
        val cb = projectionCallback
        projectionCallback = null
        if (mp == null) return
        if (cb != null) {
            try {
                mp.unregisterCallback(cb)
            } catch (e: Exception) {
                // Not fatal: stopping below is what actually ends the capture.
                Log.w(TAG, "unregisterCallback failed: ${e.message}")
            }
        }
        try {
            mp.stop()
        } catch (e: Exception) {
            Log.w(TAG, "projection stop failed: ${e.message}")
        }
    }

    @Suppress("DEPRECATION")
    private fun realMetrics(): DisplayMetrics {
        val metrics = DisplayMetrics()
        activity.windowManager.defaultDisplay.getRealMetrics(metrics)
        return metrics
    }
}
