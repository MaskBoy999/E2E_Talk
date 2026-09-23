package com.e2echat.callservice

import android.app.NotificationManager
import android.content.Context
import android.media.AudioManager
import android.os.Build
import app.tauri.plugin.JSObject

/**
 * The phone's current "may I make a noise?" state.
 *
 * WHY THE PAGE NEEDS THIS
 *
 * The system already respects the ringer mode for the *notification* — a channel
 * with a sound and a vibration pattern stays silent in silent mode, only vibrates
 * in vibrate mode, and does both on a normal ringer. But the app also rings
 * **itself**: `playRingtone()` in `static/voice.js` plays the user's (or the
 * default) ringtone through WebAudio and buzzes through the native vibrator for
 * as long as the incoming-call bar is up. WebAudio knows nothing about the
 * ringer mode, so an incoming call used to ring out loud on a phone that was on
 * silent, and buzz on a phone that was muted — the notification was politely
 * quiet while the WebView next to it was not.
 *
 * So the page reads this before it starts ringing and honours it: no sound in
 * vibrate/silent mode, no haptics in silent mode, and neither while do-not-disturb
 * is filtering.
 */
object AudioProfile {

    private const val MODE_NORMAL = "normal"
    private const val MODE_VIBRATE = "vibrate"
    private const val MODE_SILENT = "silent"

    /** `{ mode: "normal"|"vibrate"|"silent", dnd: boolean }`. */
    fun read(context: Context): JSObject {
        val out = JSObject()

        var mode = MODE_NORMAL
        try {
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            mode = when (audio?.ringerMode) {
                AudioManager.RINGER_MODE_VIBRATE -> MODE_VIBRATE
                AudioManager.RINGER_MODE_SILENT -> MODE_SILENT
                // RINGER_MODE_NORMAL, and the null/unknown case: assume the
                // phone is willing to make noise. Being wrong in this direction
                // is a ring the user hears, not a ring they never get.
                else -> MODE_NORMAL
            }
        } catch (e: Exception) {
            mode = MODE_NORMAL
        }

        // Do-not-disturb is a *separate* switch from the ringer: a phone can be
        // on its normal ringer and still have DND filtering interruptions. The
        // notification is left to the system (it knows about the user's allowed
        // contacts/apps exceptions), but the app's own ringtone has no such
        // knowledge, so it stays quiet whenever DND is on.
        var dnd = false
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                if (nm != null) {
                    dnd = nm.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL
                }
            }
        } catch (e: Exception) {
            dnd = false
        }

        out.put("mode", mode)
        out.put("dnd", dnd)
        return out
    }
}
