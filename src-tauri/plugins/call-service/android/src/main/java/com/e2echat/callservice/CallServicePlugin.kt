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

/**
 * Webview-facing half of the plugin. Called from JS as
 * `invoke('plugin:call-service|start', { channelName })` and `…|stop`.
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
}
