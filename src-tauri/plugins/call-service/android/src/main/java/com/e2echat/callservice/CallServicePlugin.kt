package com.e2echat.callservice

import android.app.Activity
import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class StartArgs {
    var channelName: String? = null
}

@InvokeArg
class IncomingCallArgs {
    var callerName: String? = null
    var dmChannelId: String? = null
}

/**
 * Webview-facing half of the plugin. Called from JS as
 * `invoke('plugin:call-service|start', { channelName })` and `…|stop`, plus the
 * `…|incomingCall` / `…|cancelIncoming` pair that raises a full-screen-intent
 * incoming-call notification while the app is backgrounded (static/voice.js).
 */
@TauriPlugin
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        val intent = Intent(activity, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_START
            putExtra(
                CallForegroundService.EXTRA_CHANNEL_NAME,
                args.channelName ?: "Voice call"
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
