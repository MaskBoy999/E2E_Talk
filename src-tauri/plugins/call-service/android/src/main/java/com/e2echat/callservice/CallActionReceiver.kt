package com.e2echat.callservice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Handles the ongoing call notification's **Mute / Deafen / Hang up** actions
 * (1.1, FEATURE_PLAN.md).
 *
 * The taps cannot act by themselves: the socket — and therefore the call —
 * lives in the WebView, so each action is forwarded to the page as
 * `window.__e2eCallAction("<mute|deafen|hangup>")` (see [CallServicePlugin]),
 * which runs exactly the in-app button. Verb names only — nothing user-visible
 * and nothing E2EE travels through this path, so the notification surface stays
 * metadata-free (F1/F2 rules in FEATURE_PLAN.md).
 *
 * Manifest-declared, so it is delivered — and the process unfrozen — even when
 * the app is backgrounded mid-call. After the page applies the change it sends
 * `updateCallState`, and the service re-posts the notification with fresh
 * labels ("Unmute" while muted, "Hang up" always).
 *
 * `onReceive` must never throw: an exception escaping a receiver kills the
 * process on some OEMs, mid-call.
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = when (intent.action) {
            CallForegroundService.ACTION_MUTE -> "mute"
            CallForegroundService.ACTION_DEAFEN -> "deafen"
            CallForegroundService.ACTION_HANGUP -> "hangup"
            else -> return
        }
        try {
            CallServicePlugin.deliverCallAction(action)
        } catch (e: Exception) {
            Log.w("E2ECallService", "could not deliver the call action: ${e.message}")
        }
    }
}
