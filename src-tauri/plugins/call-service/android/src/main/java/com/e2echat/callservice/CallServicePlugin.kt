package com.e2echat.callservice

import android.app.Activity
import android.content.Intent
import android.os.Build
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
     * Constructed here, not lazily: the class registers the screen-capture
     * permission launcher in its initialiser, and Android only allows that
     * before the activity is STARTED (plugins are built during `onCreate`).
     */
    private val screenCapture = ScreenCapture(activity)

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
     * Start sharing the screen natively. Resolves as soon as the system picker
     * has been asked; the outcome arrives on the `onFrame` channel as
     * `{type:"started"|"frame"|"stopped"|"error"}`.
     */
    @Command
    fun startScreenCapture(invoke: Invoke) {
        val args = invoke.parseArgs(ScreenCaptureArgs::class.java)
        val ch = args.onFrame
        if (ch == null) {
            invoke.reject("startScreenCapture needs an onFrame channel")
            return
        }
        try {
            screenCapture.request(ch, args.maxHeight ?: 480, args.fps ?: 10)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not start screen capture: ${e.message}")
        }
    }

    @Command
    fun stopScreenCapture(invoke: Invoke) {
        try {
            screenCapture.stop()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not stop screen capture: ${e.message}")
        }
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
