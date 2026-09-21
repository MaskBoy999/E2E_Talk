package com.e2echat.callservice

import android.app.Activity
import android.content.Intent
import android.os.Build
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class StartArgs {
    var channelName: String? = null

    /**
     * Media this call is carrying: "audio" (always), "camera", "screen".
     * Drives the Android 14+ foreground-service types — without the matching
     * type, Android revokes mic/camera capture as soon as the app is no longer
     * the foreground app (see CallForegroundService).
     */
    var mediaTypes: List<String>? = null
}

@InvokeArg
class IncomingCallArgs {
    var callerName: String? = null
    var dmChannelId: String? = null
}

/**
 * Screen capture input. `onFrame` is a Tauri channel: the page passes one in
 * and every captured frame (and every terminal state) is delivered back through
 * it. A channel is used rather than a command return because a share produces
 * hundreds of messages over its lifetime — see ScreenCapture.kt for why the
 * capture is native at all.
 */
@InvokeArg
class ScreenCaptureArgs {
    var onFrame: Channel? = null
    var maxHeight: Int? = null
    var fps: Int? = null
}

/**
 * Webview-facing half of the plugin. Called from JS as
 * `invoke('plugin:call-service|start', { channelName })` and `…|stop`, plus the
 * `…|incomingCall` / `…|cancelIncoming` pair that raises a full-screen-intent
 * incoming-call notification while the app is backgrounded (static/voice.js).
 */
@TauriPlugin
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Built on first use — deliberately, not "for performance".
     *
     * A plugin is constructed *after* the activity is already running, so any
     * lifecycle-sensitive registration performed from a constructor throws from
     * the constructor itself: `registerForActivityResult`, for example, is only
     * legal before the activity reaches STARTED. An exception escaping the
     * constructor on the launch path is an app crash on start-up, not a failed
     * screen share. Keeping the field lazy means constructing this plugin can
     * only ever allocate a reference, and the picker is launched through Tauri's
     * own activity-result plumbing instead (see [screenCaptureResult]).
     */
    private val screenCapture by lazy { ScreenCapture(activity) }

    private companion object {
        /** Same tag as ScreenCapture.kt, so one logcat filter shows the flow. */
        const val SCREEN_TAG = "E2EScreenCapture"
    }

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        val intent = Intent(activity, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_START
            putExtra(
                CallForegroundService.EXTRA_CHANNEL_NAME,
                args.channelName ?: "Voice call"
            )
            putStringArrayListExtra(
                CallForegroundService.EXTRA_MEDIA_TYPES,
                ArrayList(args.mediaTypes ?: listOf("audio"))
            )
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            invoke.resolve()
        } catch (e: Exception) {
            // Most common cause: the app was already fully backgrounded when the
            // call started, which Android forbids. The call still works while the
            // screen is on; report it so the JS side can log/toast it.
            invoke.reject("Could not start the call service: ${e.message}")
        }
    }

    /**
     * Re-apply the foreground-service types when the call's media changes
     * (camera or screen sharing toggled, or the mic re-acquired after a wake).
     * The service keeps running and re-posts the same notification; only the
     * declared types change, which is what Android checks every time it decides
     * whether background capture is still allowed.
     */
    @Command
    fun updateMedia(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        val intent = Intent(activity, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_UPDATE
            putExtra(
                CallForegroundService.EXTRA_CHANNEL_NAME,
                args.channelName ?: "Voice call"
            )
            putStringArrayListExtra(
                CallForegroundService.EXTRA_MEDIA_TYPES,
                ArrayList(args.mediaTypes ?: listOf("audio"))
            )
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not update the call service: ${e.message}")
        }
    }

    /**
     * Start sharing the screen natively: pick the geometry, ask the system
     * picker, and let [screenCaptureResult] finish it. The outcome of the
     * capture itself arrives on the `onFrame` channel as
     * `{type:"started"|"frame"|"stopped"|"error"}`.
     *
     * The picker is launched through Tauri's own activity-result plumbing rather
     * than a launcher owned by this plugin, because `PluginManager` registers
     * its launchers once from `onActivityCreate` — early enough to always be
     * legal, unlike anything we could register ourselves. This does mean the
     * command resolves after the user answers the dialog; the page does not
     * depend on that timing, since it acts on the channel messages.
     */
    @Command
    fun startScreenCapture(invoke: Invoke) {
        val args = invoke.parseArgs(ScreenCaptureArgs::class.java)
        val ch = args.onFrame
        if (ch == null) {
            invoke.reject("startScreenCapture needs an onFrame channel")
            return
        }
        val intent = try {
            screenCapture.prepare(ch, args.maxHeight ?: 480, args.fps ?: 10)
        } catch (e: Exception) {
            android.util.Log.e(SCREEN_TAG, "prepare() failed", e)
            invoke.reject("Could not start screen capture: ${e.message}")
            return
        }
        android.util.Log.i(SCREEN_TAG, "opening the system screen-capture picker")
        startActivityForResult(invoke, intent, "screenCaptureResult")
    }

    /**
     * The system picker's answer. Always resolves the command: declining the
     * dialog is a normal choice, and the page is told about it over the channel,
     * which is what raises the toast.
     */
    @ActivityCallback
    fun screenCaptureResult(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        // Everything is wrapped, including the resolve: this runs on the main
        // thread as an activity-result callback, and an exception escaping it
        // is not a failed screen share — it is a process crash. A failed
        // capture must always degrade to a message the page can show.
        try {
            if (result.resultCode == Activity.RESULT_OK && data != null) {
                android.util.Log.i(SCREEN_TAG, "capture approved by the user")
                screenCapture.begin(result.resultCode, data)
            } else {
                android.util.Log.i(SCREEN_TAG, "screen capture was not approved")
                screenCapture.fail("permission denied")
            }
        } catch (e: Exception) {
            android.util.Log.e(SCREEN_TAG, "could not start the projection", e)
            try {
                screenCapture.fail("could not start screen capture: ${e.message}")
            } catch (_: Exception) {
                // Nothing left to do; the page will time out and say so.
            }
        }
        try {
            invoke.resolve()
        } catch (e: Exception) {
            android.util.Log.w(SCREEN_TAG, "could not settle the capture command: ${e.message}")
        }
    }

    @Command
    fun stopScreenCapture(invoke: Invoke) {
        // Stopping is the one command that must never fail: it is what releases
        // the projection and gives Android back its screen-capture session. A
        // rejection here would leave the page believing a share is still live,
        // so the command always resolves and only logs.
        try {
            screenCapture.stop()
        } catch (e: Exception) {
            android.util.Log.e(SCREEN_TAG, "stop() threw", e)
        }
        invoke.resolve()
    }

    @Command
    fun stop(invoke: Invoke) {
        try {
            activity.stopService(Intent(activity, CallForegroundService::class.java))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not stop the call service: ${e.message}")
        }
    }

    /**
     * Raise the incoming-call notification with a full-screen intent. Android
     * shows it over the lock screen / other apps (subject to the
     * USE_FULL_SCREEN_INTENT permission and the user's notification settings),
     * which is the only way to visibly "ring" while our WebView is frozen.
     */
    @Command
    fun incomingCall(invoke: Invoke) {
        val args = invoke.parseArgs(IncomingCallArgs::class.java)
        try {
            IncomingCallNotifier.show(
                activity,
                args.callerName ?: "Someone",
                args.dmChannelId ?: ""
            )
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not show the incoming call: ${e.message}")
        }
    }

    @Command
    fun cancelIncoming(invoke: Invoke) {
        try {
            IncomingCallNotifier.cancel(activity)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not cancel the incoming call: ${e.message}")
        }
    }
}
