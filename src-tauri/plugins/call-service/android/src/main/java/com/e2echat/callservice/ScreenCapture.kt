package com.e2echat.callservice

import android.app.Activity
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
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
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
 *   `plugin:call-service|updateMedia` before calling in here.
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
 *
 * ## What this deliberately does not do
 *
 * No audio. `MediaProjection` audio capture needs a separate `AudioPlaybackCapture`
 * configuration and only sees other apps' audio when they opt in, and the box
 * already relays the microphone through the existing WebRTC/relay path. Screen
 * *video* is the whole feature; inventing a second audio pipeline here would
 * risk the one that works.
 */
class ScreenCapture(private val activity: Activity) {

    companion object {
        private const val TAG = "E2EScreenCapture"
        private const val QUALITY = 55

        /** Usable formats for the returned `MediaProjection` token. */
        private const val RW_FLAGS = DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR
    }

    private var projection: MediaProjection? = null
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
     * The picker's result. Registered in the initialiser on purpose: Android
     * allows `registerForActivityResult` only before the activity reaches
     * STARTED, and a plugin is constructed during `onCreate`, so doing it here
     * is the one place it is guaranteed to be legal. Registering it lazily on
     * the first `startScreenCapture` would throw `IllegalStateException`.
     */
    val permissionLauncher: ActivityResultLauncher<android.content.Intent> =
        (activity as androidx.activity.ComponentActivity).registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val data = result.data
            if (result.resultCode == Activity.RESULT_OK && data != null) {
                try {
                    beginProjection(result.resultCode, data)
                } catch (e: Exception) {
                    Log.e(TAG, "could not start the projection", e)
                    fail("could not start screen capture: ${e.message}")
                }
            } else {
                Log.i(TAG, "screen capture was not approved")
                fail("permission denied")
            }
        }

    /** Ask for permission; the answer arrives on [permissionLauncher]. */
    fun request(ch: Channel, maxHeight: Int, fps: Int) {
        stop() // never leave an older capture running
        channel = ch
        targetFps = if (fps in 1..30) fps else 10
        try {
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
            permissionLauncher.launch(mgr.createScreenCaptureIntent())
        } catch (e: Exception) {
            Log.e(TAG, "could not request screen capture", e)
            fail("could not request screen capture: ${e.message}")
        }
    }

    private fun beginProjection(resultCode: Int, data: android.content.Intent) {
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
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                Log.i(TAG, "projection stopped by the system")
                stop()
                post(mapOf("type" to "stopped"))
            }
        }, h)
        projection = mp

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        reader.setOnImageAvailableListener({ r ->
            val image = try { r.acquireLatestImage() } catch (_: Exception) { null } ?: return@setOnImageAvailableListener
            try {
                onFrame(image)
            } catch (e: Exception) {
                Log.w(TAG, "dropped a frame: ${e.message}")
            } finally {
                try { image.close() } catch (_: Exception) {}
            }
        }, h)

        virtualDisplay = mp.createVirtualDisplay(
            "e2e-screen",
            width,
            height,
            density,
            RW_FLAGS,
            reader.surface,
            null,
            h
        )
        running = true
        Log.i(TAG, "capturing ${width}x$height @ ${targetFps}fps")
        post(mapOf("type" to "started", "w" to width, "h" to height))
    }

    private fun onFrame(image: android.media.Image) {
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
        val padded = Bitmap.createBitmap(
            width + rowPadding / pixelStride,
            height,
            Bitmap.Config.ARGB_8888
        )
        padded.copyPixelsFromBuffer(plane.buffer)
        val frame = if (rowPadding == 0) padded else Bitmap.createBitmap(padded, 0, 0, width, height)
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

    private fun fail(message: String) {
        post(mapOf("type" to "error", "message" to message))
        stop()
    }

    fun stop() {
        running = false
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try { projection?.stop() } catch (_: Exception) {}
        projection = null
        try { thread?.quitSafely() } catch (_: Exception) {}
        thread = null
        handler = null
    }

    @Suppress("DEPRECATION")
    private fun realMetrics(): DisplayMetrics {
        val metrics = DisplayMetrics()
        activity.windowManager.defaultDisplay.getRealMetrics(metrics)
        return metrics
    }
}
