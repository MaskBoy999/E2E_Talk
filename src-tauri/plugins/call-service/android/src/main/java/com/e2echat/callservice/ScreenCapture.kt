package com.e2echat.callservice

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import app.tauri.plugin.Channel
import java.io.ByteArrayOutputStream
import kotlin.math.max
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
 * ## App audio ([withAudio])
 *
 * The same projection token also feeds an `AudioRecord` built with an
 * `AudioPlaybackCaptureConfiguration`, which mirrors what the *other* apps on
 * the device are playing (games, video players, everything that has not opted
 * out of capture). That audio is streamed to the page as raw PCM16 over the
 * same channel as the frames, and the page turns it into a real audio track on
 * the canvas stream — so the relay/mesh pipeline cannot tell it apart from the
 * tab audio a desktop `getDisplayMedia` share produces.
 *
 * Three things here are easy to get wrong:
 *
 * * **Our own playback is excluded** (`excludeUid`). The call itself is playing
 *   through this app; capturing it would send every remote voice straight back
 *   out to the room — a feedback loop, not a feature.
 * * **Only some usages are captured** (`USAGE_MEDIA`, `USAGE_GAME`,
 *   `USAGE_UNKNOWN`), matching what a user would call "the app's sound".
 *   Android forbids combining `addMatchingUsage` with `excludeUsage`, and
 *   `addMatchingUid` with `excludeUid` — so this picks one of each pair.
 * * **The playing app can refuse.** `allowAudioPlaybackCapture=false` or an
 *   `ALLOW_CAPTURE_BY_NONE` policy (DRM/copy-protected playback) makes this
 *   record silence. That is out of our control and must never fail the share:
 *   audio problems are reported on the channel as their own message and the
 *   video keeps running.
 */
class ScreenCapture(private val activity: Activity) {

    companion object {
        private const val TAG = "E2EScreenCapture"
        private const val QUALITY = 55

        /** Usable formats for the returned `MediaProjection` token. */
        private const val RW_FLAGS = DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR

        /**
         * App audio is captured at the rate the rest of the pipeline assumes
         * (see `RELAY_SAMPLE_RATE` in voice.js), mono: a screen share's audio is
         * usually music/effects, and the page feeds it back into a 48 kHz
         * AudioContext, so anything else would come out pitch-shifted.
         */
        private const val AUDIO_RATE = 48000

        /** 20 ms per message — small enough to stay smooth, big enough that the
         *  Tauri bridge is not chatty (50 messages/second, ~2.6 KB each). */
        private const val AUDIO_CHUNK = AUDIO_RATE / 50
    }

    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var channel: Channel? = null

    /** App-audio capture: the `AudioRecord` and the thread that drains it. */
    private var audioRecord: AudioRecord? = null
    private var audioThread: Thread? = null
    private var withAudio = false

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
    fun prepare(ch: Channel, maxHeight: Int, fps: Int, audio: Boolean): Intent {
        stop() // never leave an older capture running
        // A fresh share is allowed to start: the previous one (if any) is now
        // fully torn down.
        stopping = false
        channel = ch
        withAudio = audio
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

        // Audio rides on the same projection token. Started only after the
        // video pipeline is live, and never allowed to fail the share: the
        // record's own problems are reported as their own channel message.
        if (withAudio) startAudio(mp)

        running = true
        Log.i(TAG, "capturing ${width}x$height @ ${targetFps}fps (audio=$withAudio)")
        post(
            mapOf(
                "type" to "started",
                "w" to width,
                "h" to height,
                "fps" to targetFps,
                "audio" to withAudio
            )
        )
    }

    // ------------------------------------------------------------------
    // App audio (AudioPlaybackCapture)
    // ------------------------------------------------------------------

    /**
     * Mirror the device's playback into an `AudioRecord`. Android only lets an
     * app do this from Android 10 on, and only for apps that allow capture —
     * both cases are reported to the page rather than swallowed.
     */
    private fun startAudio(mp: MediaProjection) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            post(mapOf("type" to "audioError", "message" to "app audio needs Android 10 or newer"))
            return
        }
        val rec = try {
            val config = AudioPlaybackCaptureConfiguration.Builder(mp)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                // The call's own playback must not be re-broadcast — see the
                // class comment: that is a feedback loop.
                .excludeUid(activity.applicationInfo.uid)
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(AUDIO_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build()
            val minBytes = AudioRecord.getMinBufferSize(
                AUDIO_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(config)
                .setAudioFormat(format)
                // Room for several chunks, so a slow frame cannot starve the
                // reader and drop samples.
                .setBufferSizeInBytes(max(minBytes, AUDIO_CHUNK * 2 * 4))
                .build()
        } catch (e: Exception) {
            // A SecurityException here is the normal "this device/OEM forbids
            // playback capture" answer, not a bug.
            Log.w(TAG, "could not build the audio capture: ${e.message}")
            post(mapOf("type" to "audioError", "message" to (e.message ?: "could not capture app audio")))
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            try { rec.release() } catch (e: Exception) { Log.w(TAG, "audio release failed: ${e.message}") }
            post(mapOf("type" to "audioError", "message" to "the device refused the audio capture"))
            return
        }
        val started = try {
            rec.startRecording()
            true
        } catch (e: Exception) {
            Log.w(TAG, "could not start the audio capture: ${e.message}")
            post(mapOf("type" to "audioError", "message" to (e.message ?: "could not start app audio")))
            false
        }
        if (!started) {
            try { rec.release() } catch (e: Exception) { Log.w(TAG, "audio release failed: ${e.message}") }
            return
        }
        audioRecord = rec
        post(mapOf("type" to "audioStarted", "rate" to AUDIO_RATE))
        Log.i(TAG, "capturing app audio @ ${AUDIO_RATE}Hz")
        val t = Thread({ audioLoop(rec) }, "e2e-screen-audio")
        audioThread = t
        t.start()
    }

    /**
     * Drain the record and hand each chunk to the page as PCM16 little-endian.
     *
     * `read` is blocking, so the loop is also the thread's shutdown condition:
     * [stopAudio] clears [audioRecord] and calls `stop()`, which makes the
     * pending read return and the loop exit.
     */
    private fun audioLoop(rec: AudioRecord) {
        val shorts = ShortArray(AUDIO_CHUNK)
        val bytes = ByteArray(AUDIO_CHUNK * 2)
        while (!stopping && audioRecord === rec) {
            val n = try {
                rec.read(shorts, 0, shorts.size)
            } catch (e: Exception) {
                Log.w(TAG, "audio read failed: ${e.message}")
                -1
            }
            if (n < 0) {
                // ERROR_INVALID_OPERATION / ERROR_DEAD_OBJECT: the projection
                // went away under us. Back off rather than spin, and let the
                // projection callback tear the share down.
                if (stopping) break
                try { Thread.sleep(20) } catch (_: InterruptedException) { break }
                continue
            }
            if (n == 0) continue
            var b = 0
            for (i in 0 until n) {
                val s = shorts[i].toInt()
                bytes[b++] = (s and 0xFF).toByte()
                bytes[b++] = ((s shr 8) and 0xFF).toByte()
            }
            post(mapOf("type" to "audio", "pcm" to Base64.encodeToString(bytes, 0, n * 2, Base64.NO_WRAP)))
        }
    }

    /**
     * Stop and release the audio capture. Idempotent, and safe to call from
     * [stop] — the record is closed before the projection it was derived from.
     */
    private fun stopAudio() {
        val rec = audioRecord ?: return
        audioRecord = null
        try { rec.stop() } catch (e: Exception) { Log.w(TAG, "audio stop failed: ${e.message}") }
        val t = audioThread
        audioThread = null
        if (t != null) {
            try { t.join(300) } catch (_: InterruptedException) { /* give up waiting */ }
        }
        try { rec.release() } catch (e: Exception) { Log.w(TAG, "audio release failed: ${e.message}") }
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

        // Audio first: the record was built from the projection, so it has to
        // be released before the projection it borrows is stopped.
        stopAudio()

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
