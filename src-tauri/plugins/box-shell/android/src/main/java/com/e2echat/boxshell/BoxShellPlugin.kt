package com.e2echat.boxshell

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.view.Window
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

import java.io.File

@InvokeArg
class BackHandlerArgs {
    /**
     * Whether the page wants the hardware Back button routed to it. `false`
     * restores Android's default (Back finishes the activity), which is what the
     * page asks for when it is showing something that genuinely has no "back"
     * (the setup/address screen, for instance).
     */
    var active: Boolean = true
}

/**
 * Arguments for [`BoxShellPlugin.keepScreenOn`] (6.2, FEATURE_PLAN.md):
 * whether the screen must stay on right now.
 */
@InvokeArg
class KeepScreenOnArgs {
    var active: Boolean = false
}

@InvokeArg
class VibrateArgs {
    /**
     * Alternating buzz/pause durations in milliseconds, exactly the shape
     * `navigator.vibrate` takes: `[buzz, pause, buzz, …]`. The first entry is
     * always a buzz. An empty array — or one that is all zeros — stops whatever
     * is vibrating, which is what `navigator.vibrate(0)` means.
     */
    var pattern: List<Int> = emptyList()
}

/**
 * The Android shell half of the box.
 *
 * `activity` is the single `MainActivity` — a `TauriActivity`, so it is an
 * `AppCompatActivity` and therefore has an `OnBackPressedDispatcher`.
 *
 * Both features are re-applied from `onResume` as well as from the commands:
 * Android restores the system bars after a screen-off/on cycle, a task switch,
 * or a transient swipe that timed out, and the page cannot see all of those.
 * Re-applying is idempotent, so it is safe to do whenever the activity comes
 * back to the front.
 *
 * It also carries the two device duties the WebView cannot perform for itself:
 * `vibrate` (Chromium dropped the Vibration API on Android, so every haptic cue
 * in the app was silently dead inside the box whatever the settings said) and
 * `clearNotifications` (the shade must be empty on return, minus an ongoing
 * call).
 */
/** Arguments for `setAudioRoute` (1.3): the device id to route call audio to. */
@InvokeArg
class AudioRouteArgs {
    var id: String? = null
}

/** Arguments for `sharedRead` (3.4): which staged file (index into the FIFO). */
@InvokeArg
class SharedReadArgs {
    var index: Int = -1
}

/**
 * Arguments for `copyFileToClipboard`: the file's real name, its MIME type, and
 * the decrypted bytes as base64.
 *
 * Base64 (and not a raw body) because Android's IPC has no request body — the
 * desktop half of this same command reads the bytes raw, and the page picks the
 * shape for the platform it is running on.
 */
@InvokeArg
class CopyFileArgs {
    var name: String? = null
    var mime: String? = null
    var data: String? = null
}

/**
 * Arguments for `saveFile`: the file's real name, its MIME type, and the
 * decrypted bytes as base64 — the same shape (and the same reason) as
 * [CopyFileArgs]: Android's IPC has no request body, so the desktop half reads
 * the bytes raw while the phone carries them base64.
 */
@InvokeArg
class SaveFileArgs {
    var name: String? = null
    var mime: String? = null
    var data: String? = null
}

@TauriPlugin
class BoxShellPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /**
         * The ongoing "In call" notification, owned by the call-service plugin
         * (`CallForegroundService.NOTIFICATION_ID`). It has to survive
         * [clearNotifications]: while a call is up, that notification *is* the
         * call's presence in the shade and the way back into it. Keep the two
         * numbers in step if the call notification id ever moves.
         */
        private const val ONGOING_CALL_NOTIFICATION_ID = 4711

        /**
         * 3.4 (FEATURE_PLAN.md): the inbound share FIFO.
         *
         * Staged in PROCESS MEMORY (text) and the app's own cacheDir (file
         * bytes) until the page consumes it — `sharedPending` → `sharedRead`
         * → `sharedDiscard`. Two plan rules, encoded here:
         *  - the text of a share is NEVER written to disk (the FIFO carries
         *    file bytes only; a message body on disk would be a durable
         *    plaintext copy outside every at-rest control, R5);
         *  - everything is dropped on read and replaced by the next share, so
         *    no backlog of shared content accumulates.
         * [SharedContentActivity] is the only writer.
         */
        data class StagedFile(val file: File, val name: String, val mime: String)
        data class PendingShared(val text: String?, val files: List<StagedFile>)

        @Volatile
        private var pendingShared: PendingShared? = null

        /** Cap: a share is an import, not a file-transfer protocol. */
        private const val MAX_SHARED_FILE_BYTES = 25L * 1024 * 1024
        private const val MAX_SHARED_TEXT_CHARS = 100_000

        /**
         * The save-to-disk cap. Larger than the share/clipboard cap because a
         * save is the real download path (a video attachment is the common
         * case), but still bounded: the payload crosses JSON IPC as one base64
         * string, so it is a memory budget on the phone, not a disk one.
         */
        private const val MAX_SAVE_FILE_BYTES = 100L * 1024 * 1024

        /** Read-only view for `sharedPending` / `sharedRead`. */
        @JvmStatic
        fun peekShared(): PendingShared? = pendingShared

        /** `sharedDiscard`: drop the staged text and delete the cached copies. */
        @JvmStatic
        fun discardShared() {
            pendingShared?.files?.forEach { f -> try { f.file.delete() } catch (_: Exception) {} }
            pendingShared = null
        }

        /**
         * Stage an ACTION_SEND intent: text into RAM, file bytes into the app's
         * own cache. Never throws — a failed share must not crash the app.
         * A new share replaces anything unconsumed (no backlog).
         */
        @JvmStatic
        fun stageShared(context: Context, intent: Intent?) {
            try {
                if (intent == null) return
                var text: String? = null
                try {
                    text = intent.getStringExtra(Intent.EXTRA_TEXT)
                        ?: intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
                } catch (_: Exception) {
                }
                if (text != null && text.length > MAX_SHARED_TEXT_CHARS) text = null

                val uris = mutableListOf<Uri>()
                try {
                    intent.clipData?.let { cd ->
                        for (i in 0 until cd.itemCount) cd.getItemAt(i)?.uri?.let { uris.add(it) }
                    }
                    if (uris.isEmpty()) {
                        @Suppress("DEPRECATION")
                        (intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri)
                            ?.let { uris.add(it) }
                    }
                } catch (_: Exception) {
                }

                discardShared()
                val dir = File(context.cacheDir, "shared").apply { mkdirs() }
                val staged = uris.mapNotNull { uri ->
                    try {
                        var name = "shared.bin"
                        val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                        context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                            val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (i >= 0 && c.moveToFirst()) c.getString(i)?.let { name = it }
                        }
                        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "shared.bin" }
                        val out = File(dir, "${System.currentTimeMillis()}-$safe")
                        val input = context.contentResolver.openInputStream(uri) ?: return@mapNotNull null
                        input.use { ins -> out.outputStream().use { ins.copyTo(it) } }
                        if (out.length() > MAX_SHARED_FILE_BYTES) { out.delete(); return@mapNotNull null }
                        StagedFile(out, name, mime)
                    } catch (_: Exception) {
                        null
                    }
                }
                if (text == null && staged.isEmpty()) return
                pendingShared = PendingShared(text, staged)
            } catch (_: Exception) {
            }
        }
    }

    /** Whether the page currently wants the system bars hidden. */
    private var immersive = false

    /** Whether our back callback has been attached to the activity (once). */
    private var backInstalled = false

    /**
     * Routes Back to the page instead of finishing the activity.
     *
     * Registered disabled, so if the page never asks for it, or the app is
     * finishing, Android's own behaviour is untouched. Attaching this is what
     * *replaces* the default: the generated `TauriActivity` sets
     * `handleBackNavigation = false`, which means wry adds no callback at all,
     * so without this the system's default (finish) is all that exists.
     */
    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            // `Plugin.trigger` reaches the WebView's JS listeners. The page
            // closes its topmost layer and, if there was nothing to close,
            // invokes `exit` — see static/box-shell.js.
            trigger("box:back", JSObject())
        }
    }

    override fun onResume() {
        super.onResume()
        if (immersive) applyImmersive()
    }

    /** Hide the status + navigation bars; a swipe reveals them transiently. */
    @Command
    fun enterImmersive(invoke: Invoke) {
        immersive = true
        applyImmersive()
        invoke.resolve()
    }

    /** Show them again (e.g. the setup screen, where an address is typed). */
    @Command
    fun exitImmersive(invoke: Invoke) {
        immersive = false
        showBars()
        invoke.resolve()
    }

    /** Turn the Back interception on or off for the current screen. */
    @Command
    fun setBackHandler(invoke: Invoke) {
        val args = invoke.parseArgs(BackHandlerArgs::class.java)
        installBackCallback()
        backCallback.isEnabled = args.active && backInstalled
        invoke.resolve()
    }

    /**
     * Leave the app — what the page asks for when Back was pressed and nothing
     * was open. `finishAndRemoveTask` also drops the task from Recents, which is
     * what "closed the app" should look like; a plain `finish()` would leave the
     * entry behind to be resumed into.
     */
    @Command
    fun exit(invoke: Invoke) {
        invoke.resolve()
        activity.runOnUiThread {
            activity.finishAndRemoveTask()
        }
    }

    /**
     * Buzz the phone's real vibrator with a `navigator.vibrate`-shaped pattern.
     *
     * This command exists because the page cannot reach the hardware itself:
     * Chromium **disabled the Vibration API on Android in v79**, and left the
     * *interface* in place. So `navigator.vibrate` is defined, is not blocked,
     * returns `true` while the page is visible, and does nothing at all — every
     * cue (incoming call, ring→waiting, notification, and the "Test pattern"
     * buttons, which are exactly where a user goes to check) looked correct in a
     * browser and was dead inside the app.
     *
     * `VibrationEffect.createWaveform` takes the same alternating buzz/pause
     * array the page already builds, so a configured pattern plays as ONE
     * hardware waveform — no JS timers stringing pulses together, and no drift if
     * the WebView freezes mid-pattern (which is precisely when a call cue
     * matters).
     */
    @Command
    fun vibrate(invoke: Invoke) {
        val args = invoke.parseArgs(VibrateArgs::class.java)
        val timings = args.pattern.map { it.coerceAtLeast(0).toLong() }.toLongArray()
        val vibrator = vibrator()
        // No vibrator (an emulator, a tablet, a phone in a mode that reports
        // none) is not an error: the cue was best-effort to begin with.
        if (vibrator == null || !vibrator.hasVibrator()) {
            invoke.resolve()
            return
        }
        try {
            if (timings.isEmpty() || timings.all { it == 0L }) {
                vibrator.cancel()
            } else {
                vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
            }
            invoke.resolve()
        } catch (e: Exception) {
            // A refused vibration must never take the page down with it.
            invoke.reject(e.message ?: "vibrate failed")
        }
    }

    /**
     * Keep the screen on (or let it sleep again) — 6.2, FEATURE_PLAN.md.
     *
     * The page calls this with `true` when a call starts and `false` when it
     * ends: a voice call with the screen off in a pocket is exactly when a
     * phone locks, dims and (with Doze, see `batteryRequest`) goes quiet.
     * `FLAG_KEEP_SCREEN_ON` is the platform's own mechanism — no WakeLock for
     * the app to leak, and the flag dies with the window it is set on.
     */
    @Command
    fun keepScreenOn(invoke: Invoke) {
        val args = invoke.parseArgs(KeepScreenOnArgs::class.java)
        activity.runOnUiThread {
            val w = window()
            if (args.active) {
                w?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                w?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        invoke.resolve()
    }

    /**
     * Whether the app already ignores battery optimizations — 6.1,
     * FEATURE_PLAN.md. Returns `{ignoring:true}` when there is nothing to ask
     * for (no PowerManager, or an OEM build that reports no optimization at
     * all), so the page never opens a pointless system dialog.
     */
    @Command
    fun batteryStatus(invoke: Invoke) {
        val pm = activity.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val out = JSObject()
        out.put("ignoring", pm?.isIgnoringBatteryOptimizations(activity.packageName) ?: true)
        invoke.resolve(out)
    }

    /**
     * Open the system "let this app ignore battery optimizations" dialog —
     * 6.1, FEATURE_PLAN.md.
     *
     * Doze is the number-one way an Android voice app dies in the background,
     * and it reads exactly like a bug ("the call went quiet after a while").
     * The direct `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent is the
     * only reliable route — there is no settings screen for the app to deep-
     * link to — and the *user* makes the choice in Android's own dialog; the
     * app never flips the setting itself. The manifest declares
     * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS for this intent.
     */
    @Command
    fun batteryRequest(invoke: Invoke) {
        try {
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${activity.packageName}")
            )
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            // An OEM that refuses the intent is a lost prompt, not a crash.
            invoke.reject(e.message ?: "batteryRequest failed")
        }
    }

    /**
     * Dismiss every notification this app posted, except the ongoing call.
     *
     * Coming back to the app means whatever was waiting has now been seen, so
     * the shade should be empty — the notifications that used to sit there for
     * good were ones the user had already read, and nothing could clear them
     * (the notification plugin's shim posts a plain object with no `close()`).
     * The in-call notification is deliberately left alone: while a call is up it
     * *is* the call's presence in the shade and the way back to it.
     */
    @Command
    fun clearNotifications(invoke: Invoke) {
        try {
            val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            manager?.activeNotifications?.forEach { status ->
                if (status.id != ONGOING_CALL_NOTIFICATION_ID) manager.cancel(status.id)
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "clearNotifications failed")
        }
    }

    /**
     * The device vibrator, through the manager that replaced the service in
     * Android 12 (API 31); the older service lookup is kept for API 29/30, which
     * this app still supports (`bundle.android.minSdkVersion` is 29).
     */
    private fun vibrator(): Vibrator? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    } catch (e: Exception) {
        null
    }

    // ── 1.3 (FEATURE_PLAN.md): audio output routing ────────────────────────
    // The WebView cannot choose a call-audio route; AudioManager can (API 31+
    // setCommunicationDevice, with the pre-31 speakerphone fallback our minSdk
    // 29 still needs). Local device state only — nothing leaves the process.

    @Command
    fun audioRoutes(invoke: Invoke) {
        val out = JSObject()
        val routes = org.json.JSONArray()
        try {
            val am = activity.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            if (am != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                var current = ""
                try { current = am.communicationDevice?.id?.toString() ?: "" } catch (_: Exception) {}
                for (d in am.availableCommunicationDevices) {
                    val item = org.json.JSONObject()
                    item.put("id", d.id)
                    item.put("type", routeType(d.type))
                    val pretty = d.productName?.toString() ?: ""
                    item.put("name", pretty.ifEmpty { routeTypeName(d.type) })
                    routes.put(item)
                }
                out.put("routes", routes)
                out.put("current", current)
            } else {
                // Pre-31 (or no audio service): the only route the platform
                // exposes is speaker on/off — show exactly those.
                val speakerOn = try { am?.isSpeakerphoneOn == true } catch (_: Exception) { false }
                val item = org.json.JSONObject()
                item.put("id", "speaker")
                item.put("type", "speaker")
                item.put("name", "Speaker")
                routes.put(item)
                out.put("routes", routes)
                out.put("current", if (speakerOn) "speaker" else "")
            }
        } catch (_: Exception) {
            out.put("routes", routes)
            out.put("current", "")
        }
        invoke.resolve(out)
    }

    @Command
    fun setAudioRoute(invoke: Invoke) {
        val args = invoke.parseArgs(AudioRouteArgs::class.java)
        val out = JSObject()
        try {
            val am = activity.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            val id = args.id ?: ""
            var ok = false
            if (am != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    ok = if (id.isEmpty()) {
                        am.clearCommunicationDevice()
                        true
                    } else {
                        val target = am.availableCommunicationDevices.firstOrNull { it.id.toString() == id }
                        if (target != null) am.setCommunicationDevice(target) else false
                    }
                } else {
                    am.isSpeakerphoneOn = (id == "speaker")
                    ok = true
                }
            }
            out.put("ok", ok)
        } catch (_: Exception) {
            out.put("ok", false)
        }
        invoke.resolve(out)
    }

    private fun routeType(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth"
        else -> "other"
    }

    private fun routeTypeName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET -> "Wired headset"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth"
        else -> "Audio output"
    }

    // ── 3.4 (FEATURE_PLAN.md): share-into-app consumption ────────────────
    // [SharedContentActivity] stages; these three drain: pending (what is
    // staged, metadata only), read (one file as base64, ≤25 MB), discard
    // (delete the cached copies + clear the RAM copy). Consume-once by
    // construction: discard runs right after a successful read loop in JS.

    @Command
    fun sharedPending(invoke: Invoke) {
        val out = JSObject()
        try {
            val p = peekShared()
            if (p == null) {
                out.put("staged", false)
            } else {
                out.put("staged", true)
                p.text?.let { out.put("text", it) }
                val files = org.json.JSONArray()
                p.files.forEach { f ->
                    val item = org.json.JSONObject()
                    item.put("name", f.name)
                    item.put("mime", f.mime)
                    files.put(item)
                }
                out.put("files", files)
            }
        } catch (_: Exception) {
            out.put("staged", false)
        }
        invoke.resolve(out)
    }

    @Command
    fun sharedRead(invoke: Invoke) {
        val args = invoke.parseArgs(SharedReadArgs::class.java)
        try {
            val p = peekShared()
            if (p == null) { invoke.reject("nothing staged"); return }
            val f = p.files.getOrNull(args.index)
            if (f == null) { invoke.reject("no such shared file"); return }
            val bytes = f.file.readBytes()
            val out = JSObject()
            out.put("name", f.name)
            out.put("mime", f.mime)
            out.put("dataB64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            invoke.resolve(out)
        } catch (e: Exception) {
            invoke.reject("could not read shared file: ${e.message}")
        }
    }

    @Command
    fun sharedDiscard(invoke: Invoke) {
        try { discardShared() } catch (_: Exception) {}
        invoke.resolve()
    }

    /**
     * Put a decrypted attachment on the clipboard as a **file** (0.2.30).
     *
     * Chromium's async Clipboard API writes text and images and nothing else, so
     * the page cannot copy an `.exe`, `.zip` or `.pdf` by itself — the same
     * limitation the desktop half works around with `CF_HDROP` / the macOS
     * pasteboard / X11 `text/uri-list`. Here a clipboard entry is a **URI**, so
     * the bytes are written into the app's own cacheDir and shared through the
     * `FileProvider` the generated manifest already declares
     * (`${applicationId}.fileprovider`, whose `cache-path` covers exactly this
     * directory); the system then grants the pasting app read access.
     *
     * One file at a time, and it is deleted before each write: a URI forces the
     * bytes to outlive the call, so nothing is left behind that a *later* paste
     * could still reach.
     */
    @Command
    fun copyFileToClipboard(invoke: Invoke) {
        val args = invoke.parseArgs(CopyFileArgs::class.java)
        val name = clipboardName(args.name)
        try {
            val bytes = try {
                Base64.decode(args.data ?: "", Base64.DEFAULT)
            } catch (_: Exception) {
                invoke.reject("copyFileToClipboard: payload is not base64")
                return
            }
            if (bytes.isEmpty()) {
                invoke.reject("copyFileToClipboard: nothing to copy")
                return
            }
            // The share FIFO's cap, reused deliberately: a clipboard copy is a
            // paste, not a file transfer, and the whole payload arrives as one
            // base64 string over JSON IPC.
            if (bytes.size > MAX_SHARED_FILE_BYTES) {
                invoke.reject(
                    "copyFileToClipboard: too large to copy (over " +
                        "${MAX_SHARED_FILE_BYTES / (1024 * 1024)} MB)"
                )
                return
            }
            val dir = File(activity.cacheDir, "clipboard").apply { mkdirs() }
            dir.listFiles()?.forEach { stale -> try { stale.delete() } catch (_: Exception) {} }
            val file = File(dir, name)
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
            val clip = ClipData.newUri(activity.contentResolver, name, uri)
            val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            if (manager == null) {
                invoke.reject("copyFileToClipboard: no clipboard service")
                return
            }
            manager.setPrimaryClip(clip)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("copyFileToClipboard: ${e.message}")
        }
    }

    /**
     * A filesystem-safe rendering of an attachment name, matching the desktop
     * half's `safe_name` so both platforms land on the same file name. The name
     * comes from message content the server stores, so it may not choose the
     * path it lands in, and the extension is kept because it is what tells the
     * pasting app what kind of file this is.
     */
    /**
     * Save a decrypted file into the phone's public **Downloads** collection.
     *
     * An `<a download>` on a `blob:` URL is dropped by the Android WebView, so
     * "Download"/"Save a copy"/an export had to be a page click that produced no
     * file — the exact behaviour reported (works in a browser, nothing in the
     * app). `MediaStore` is the modern way in: inserting a row into the Downloads
     * collection needs **no** storage permission from API 29 on (the collection
     * is indexed and visible in Files/Downloads), which is why the payload is
     * capped rather than routed through a legacy path. `IS_PENDING` hides the
     * entry until the bytes are fully written, so a half-saved file is never
     * visible.
     *
     * MediaStore itself de-duplicates a repeated name (`report (1).pdf`), so the
     * second save of the same attachment is an added file, not an overwrite.
     */
    @Command
    fun saveFile(invoke: Invoke) {
        val args = invoke.parseArgs(SaveFileArgs::class.java)
        val name = clipboardName(args.name)
        val mime = args.mime?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        try {
            val bytes = try {
                Base64.decode(args.data ?: "", Base64.DEFAULT)
            } catch (_: Exception) {
                invoke.reject("saveFile: payload is not base64")
                return
            }
            if (bytes.isEmpty()) {
                invoke.reject("saveFile: nothing to save")
                return
            }
            // The whole payload arrives as one base64 string over JSON IPC; a
            // phone that tries to hold a multi-hundred-megabyte string plus the
            // decoded copy is an OOM, not a save. Refuse with a reason the page
            // can repeat.
            if (bytes.size > MAX_SAVE_FILE_BYTES) {
                invoke.reject(
                    "saveFile: too large to save (over " +
                        "${MAX_SAVE_FILE_BYTES / (1024 * 1024)} MB)"
                )
                return
            }
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = activity.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            if (uri == null) {
                invoke.reject("saveFile: could not create the download entry")
                return
            }
            try {
                val out = resolver.openOutputStream(uri)
                if (out == null) throw Exception("could not open the download for writing")
                out.use { it.write(bytes) }
            } catch (e: Exception) {
                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                invoke.reject("saveFile: ${e.message}")
                return
            }
            // Publish it: while IS_PENDING is 1 the file is invisible to the
            // gallery and to Files, so a crash mid-write leaves nothing behind.
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)

            val out = JSObject()
            out.put("name", name)
            out.put("uri", uri.toString())
            invoke.resolve(out)
        } catch (e: Exception) {
            invoke.reject("saveFile: ${e.message}")
        }
    }

    private fun clipboardName(raw: String?): String {
        val cleaned = (raw ?: "").map { ch ->
            if (ch.isISOControl() || ch in "/\\:*?\"<>|") '_' else ch
        }.joinToString("").take(120)
        val trimmed = cleaned.trim('.', ' ').replace("..", "__")
        return trimmed.ifEmpty { "attachment" }
    }

    private fun window(): Window? = activity.window

    private fun installBackCallback() {
        if (backInstalled) return
        // Every Tauri mobile activity is an AppCompatActivity, so this holds —
        // but a plain Activity (a future Tauri change, or a different entry
        // activity) must not crash the app, it just loses the feature.
        val host = activity as? AppCompatActivity ?: return
        host.onBackPressedDispatcher.addCallback(host, backCallback)
        backInstalled = true
    }

    // ─── 1.7 on-device live captions ─────────────────────────────────────
    //
    // The plan's exploit review puts two rules on the captions engine, and this
    // is the only layer that can actually enforce them:
    //
    //   1. The engine must be OFFLINE. `isRecognitionAvailable()` is NOT enough
    //      — that can be the network recogniser, which ships the audio to
    //      Google and would take a call's audio off the device, the single thing
    //      captions must never do. So availability is
    //      `SpeechRecognizer.isOnDeviceRecognitionAvailable()` (API 31+) only.
    //   2. Starting captions uses `createOnDeviceSpeechRecognizer` and
    //      EXTRA_PREFER_OFFLINE, and REJECTS when the device has no on-device
    //      recogniser rather than silently falling back to the network one.
    //
    // Scope, stated plainly: the recogniser listens to the MICROPHONE — what
    // this device's user is saying. Android hands the far end of a call only to
    // a system app (CAPTURE_AUDIO_OUTPUT), so this feature does not transcribe
    // the other participants, and the UI says so.

    private var recognizer: SpeechRecognizer? = null
    private var captionsActive = false
    private val captionHandler = Handler(Looper.getMainLooper())

    private fun onDeviceRecognizerAvailable(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        return try {
            SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)
        } catch (_: Exception) {
            false
        }
    }

    private fun hasMicPermission(): Boolean =
        activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /**
     * Report whether captions can run at all. `available` is true only for an
     * offline recogniser that also has a microphone to listen to.
     */
    @Command
    fun captionsAvailable(invoke: Invoke) {
        val onDevice = onDeviceRecognizerAvailable()
        val mic = hasMicPermission()
        invoke.resolve(JSObject().apply {
            put("available", onDevice && mic)
            put("onDevice", onDevice)
            put("reason", when {
                !onDevice -> "no-offline-recognizer"
                !mic -> "no-microphone-permission"
                else -> ""
            })
        })
    }

    private fun emitCaption(text: String, isFinal: Boolean) {
        trigger("box:caption", JSObject().apply {
            put("text", text)
            put("final", isFinal)
        })
    }

    private fun stopRecognizer() {
        val r = recognizer
        recognizer = null
        if (r != null) {
            try { r.stopListening() } catch (_: Exception) {}
            try { r.cancel() } catch (_: Exception) {}
            try { r.destroy() } catch (_: Exception) {}
        }
    }

    /**
     * Restart listening after an utterance: an on-device recogniser ends its
     * session at every result, and captions are supposed to keep going until the
     * user turns them off. Only ever restarted while `captionsActive`.
     */
    private fun listenForCaptions() {
        if (!captionsActive) return
        val r = recognizer ?: return
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            // The belt to createOnDeviceSpeechRecognizer's braces: even a session
            // created on-device is told to stay on-device.
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
        }
        try { r.startListening(intent) } catch (_: Exception) { captionsActive = false }
    }

    @Command
    fun captionsStart(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !onDeviceRecognizerAvailable()) {
            // Fail closed. The network recogniser is right there and would work
            // — and would break E2EE for the call's audio, which is the entire
            // reason this feature exists as a native one.
            invoke.reject("no-offline-recognizer")
            return
        }
        if (!hasMicPermission()) {
            invoke.reject("no-microphone-permission")
            return
        }
        activity.runOnUiThread {
            try {
                stopRecognizer()
                val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
                if (r == null) { invoke.reject("no-offline-recognizer"); return@runOnUiThread }
                recognizer = r
                captionsActive = true
                r.setRecognitionListener(object : RecognitionListener {
                    override fun onPartialResults(partialResults: Bundle?) {
                        val text = partialResults
                            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull()
                        if (!text.isNullOrBlank()) emitCaption(text, false)
                    }

                    override fun onResults(results: Bundle?) {
                        val text = results
                            ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            ?.firstOrNull()
                        if (!text.isNullOrBlank()) emitCaption(text, true)
                        listenForCaptions()
                    }

                    override fun onError(error: Int) {
                        // Reported, never swallowed: the page shows "captions
                        // stopped" instead of a panel that has quietly died.
                        trigger("box:caption", JSObject().apply {
                            put("text", "")
                            put("final", true)
                            put("error", error)
                        })
                        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                            captionsActive = false
                            return
                        }
                        // Transient errors (no speech, a busy recogniser, a
                        // momentary timeout) just mean "listen again".
                        captionHandler.postDelayed({ listenForCaptions() }, 400)
                    }

                    override fun onReadyForSpeech(params: Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
                listenForCaptions()
                invoke.resolve()
            } catch (e: Exception) {
                captionsActive = false
                stopRecognizer()
                invoke.reject(e.message ?: "captions failed to start")
            }
        }
    }

    @Command
    fun captionsStop(invoke: Invoke) {
        captionsActive = false
        activity.runOnUiThread { stopRecognizer() }
        invoke.resolve()
    }

    /**
     * `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` is the whole point: the user's
     * gesture — drag from the top of the screen, or up from the bottom — brings
     * the bar in for a moment, and it hides itself again. The default behaviour
     * would leave the bar on screen until the app hid it again.
     */
    private fun applyImmersive() {
        val window = window() ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Let the app draw into the notch/cutout area as well; otherwise the
            // cutout would keep a permanent black bar at the top of a phone that
            // has one, which is most of them.
            val attrs = window.attributes
            attrs.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            window.attributes = attrs
        }
        val controller = controller(window) ?: return
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun showBars() {
        val window = window() ?: return
        controller(window)?.show(WindowInsetsCompat.Type.systemBars())
    }

    private fun controller(window: Window): WindowInsetsControllerCompat? =
        WindowCompat.getInsetsController(window, window.decorView)
}
