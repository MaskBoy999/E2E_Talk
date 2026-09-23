package com.e2echat.callservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The incoming-call notification (plan §A3.6 / "Full-screen incoming call").
 *
 * When the app is backgrounded the WebView is frozen, so the in-app ring bar
 * cannot render. This posts a high-importance notification with a
 * **full-screen intent**, which Android is allowed to show on top of the lock
 * screen or whatever app is in the foreground — the standard VoIP ringing UX.
 *
 * Tapping (or answering) launches the app; **Decline** stops the ring *and* tells
 * the page to end the call (see [IncomingCallActionReceiver] — cancelling the
 * notification alone used to leave the caller ringing).
 *
 * ## Sound and vibration belong to the channel
 *
 * On Android 8+ a notification's own sound/vibration are owned by its channel,
 * and a channel's sound and vibration pattern are **fixed when it is created**
 * ("After you create a notification channel, you can't change the notification
 * channel's visual and auditory behaviors programmatically. Only the user can").
 * That is why the phone used *its* default notification buzz instead of the
 * pattern from Settings → Voice → Haptics: the old channel was created once with
 * `enableVibration(true)` and no pattern.
 *
 * The fix is to make the channel mirror the user's configured pattern by giving
 * each pattern its own channel id, and deleting the previous one when the pattern
 * changes so the app's notification list never grows an entry per edit. The
 * channel ID is therefore derived from the pattern; `ensureChannel` returns the
 * id the notification must be posted to.
 *
 * The channel deliberately keeps a **ringtone as its sound** rather than alerting
 * from our own process: SystemUI plays a channel's sound itself, so it still rings
 * when our process is cached/frozen, and it inherits the phone's ringer mode and
 * do-not-disturb policy for free. (The app's *own* WebAudio ringtone does not —
 * see [AudioProfile] and the gate in `static/voice.js`.)
 *
 * Requires `USE_FULL_SCREEN_INTENT` (declared in the plugin manifest) and, on
 * Android 13+, the user having granted POST_NOTIFICATIONS.
 */
object IncomingCallNotifier {

    private const val NOTIFICATION_ID = 4712
    private const val TAG = "E2EIncomingCall"

    /** Base of the channel id; the user's vibration pattern is appended. */
    private const val CHANNEL_PREFIX = "e2e_incoming_call"

    private const val PREFS = "e2e_incoming_call"
    private const val PREF_CHANNEL_ID = "channel_id"

    const val ACTION_DECLINE = "com.e2echat.callservice.action.DECLINE"
    const val ACTION_ANSWER = "com.e2echat.callservice.action.ANSWER"
    const val EXTRA_DM_CHANNEL_ID = "dmChannelId"

    /**
     * Show (or refresh) the ring notification.
     *
     * `hideIdentity` (F2, FEATURE_PLAN.md) is the page's "hide message content
     * in notifications" preference: when true the card names NOBODY (title
     * only), the notification channel is locked to the private lock-screen
     * visibility, and the notification itself is VISIBILITY_PRIVATE — so the
     * caller's identity never lands on the lock screen or in Android's
     * notification history (the durable OS-held copies the FBI recovered
     * Signal previews from on iOS). When false the ring is unchanged: the
     * caller is named with the plaintext @username, which is metadata the
     * server already holds.
     */
    fun show(
        context: Context,
        callerName: String,
        dmChannelId: String,
        vibratePattern: LongArray,
        hideIdentity: Boolean = false
    ) {
        val channelId = ensureChannel(context, vibratePattern, hideIdentity)

        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val fullScreenIntent = PendingIntent.getActivity(
            context,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = PendingIntent.getBroadcast(
            context,
            1,
            Intent(context, IncomingCallActionReceiver::class.java).apply {
                action = ACTION_DECLINE
                // Carried so the page can tell WHICH ring was declined. FLAG_UPDATE_CURRENT
                // below is what keeps this extra current across re-rings.
                putExtra(EXTRA_DM_CHANNEL_ID, dmChannelId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val answerIntent = PendingIntent.getBroadcast(
            context,
            // Distinct code from Decline (1) so the two PendingIntents never collide.
            2,
            Intent(context, IncomingCallActionReceiver::class.java).apply {
                action = ACTION_ANSWER
                putExtra(EXTRA_DM_CHANNEL_ID, dmChannelId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, channelId)
            .setContentTitle("Incoming call")
            .apply {
                if (hideIdentity) {
                    // F2: name-free — see the show() doc comment.
                    setContentText("Tap to answer in E2E Chat")
                } else {
                    setContentText("$callerName is calling…")
                }
            }
            // The app's own mark, in silhouette — NOT applicationInfo.icon.
            // Android renders a small icon as an alpha mask, so handing it the
            // full-colour (and adaptive) launcher icon produced a shapeless
            // white blob in the status bar instead of the app's logo.
            .setSmallIcon(R.drawable.ic_notification)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(fullScreenIntent)
            // The full-screen intent is what makes this ring over the lock
            // screen instead of waiting quietly in the shade.
            .setFullScreenIntent(fullScreenIntent, true)
            // F2: private when hiding identity — never painted on a locked
            // phone. Public otherwise (the @username is server-known metadata).
            .setVisibility(
                if (hideIdentity) NotificationCompat.VISIBILITY_PRIVATE
                else NotificationCompat.VISIBILITY_PUBLIC
            )
            .addAction(0, "Answer", answerIntent)
            .addAction(0, "Decline", declineIntent)

        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
        } catch (e: Exception) {
            // POST_NOTIFICATIONS not granted (Android 13+), or an OEM refused
            // the post: nothing we can do from here, and the in-app bar still
            // lights up when the user returns. Never let it escape — this runs
            // on the way into a call.
            Log.w(TAG, "could not post the incoming-call notification: ${e.message}")
        }
    }

    fun cancel(context: Context) {
        try {
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
        } catch (e: Exception) {
            Log.w(TAG, "could not cancel the incoming-call notification: ${e.message}")
        }
    }

    /**
     * The channel the notification must be posted to, keyed by the user's
     * vibration pattern AND the identity-visibility mode. On a pattern change
     * the old channel is deleted and a new one created — see the class comment
     * for why a channel cannot simply be updated. The hide-identity mode is
     * part of the id for the same reason: a channel's lock-screen visibility
     * is fixed at creation too, and toggling the preference (F2) must actually
     * take effect, so the previous mode's channel is deleted like a previous
     * pattern's. Falls back to the plain prefix on anything unexpected, which
     * is still a working (if default-vibrating) channel.
     */
    private fun ensureChannel(context: Context, vibratePattern: LongArray, hideIdentity: Boolean): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return CHANNEL_PREFIX
        val pattern = vibratePattern.filter { it > 0 }
        val patternPart = if (pattern.isEmpty()) "novibe" else pattern.joinToString("-")
        val id = "$CHANNEL_PREFIX-$patternPart" + if (hideIdentity) "-priv" else ""
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return id
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val previous = prefs.getString(PREF_CHANNEL_ID, null)
            if (previous == id && manager.getNotificationChannel(id) != null) return id

            val channel = NotificationChannel(
                id,
                "Incoming calls",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Rings when someone calls you"
                // F2: the channel locks the lock-screen visibility for every
                // notification posted on it, so the hide-identity mode must be
                // baked in here (hence the mode suffix in the id above).
                lockscreenVisibility =
                    if (hideIdentity) Notification.VISIBILITY_PRIVATE
                    else Notification.VISIBILITY_PUBLIC
                if (pattern.isEmpty()) {
                    // Settings → Voice → Haptics turned the cue off: the ring is
                    // the notification's job, the buzz is not.
                    enableVibration(false)
                } else {
                    enableVibration(true)
                    vibrationPattern = pattern.toLongArray()
                }
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .build()
                )
            }
            manager.createNotificationChannel(channel)
            // Drop the previous pattern's channel so the app's notification
            // settings don't accumulate one entry per slider edit.
            if (!previous.isNullOrEmpty() && previous != id) {
                try {
                    manager.deleteNotificationChannel(previous)
                } catch (e: Exception) {
                    Log.w(TAG, "could not delete the old channel $previous: ${e.message}")
                }
            }
            prefs.edit().putString(PREF_CHANNEL_ID, id).apply()
            return id
        } catch (e: Exception) {
            Log.w(TAG, "channel setup failed, using $CHANNEL_PREFIX: ${e.message}")
            return CHANNEL_PREFIX
        }
    }
}

/**
 * Handles the notification's **Decline** and **Answer** actions.
 *
 * This used to only dismiss the notification, which is why declining from the
 * shade looked like it worked while the caller kept ringing: nothing ever told
 * the page, and the page is what owns the call (the socket lives in the WebView).
 * The action now forwards the decline to the page as well, which ends the call
 * exactly as the in-app Decline button does.
 *
 * A manifest-declared receiver like this is delivered even when the process is in
 * the cached state — Android unfreezes it to run `onReceive` — so the hand-off
 * happens while the app is still in the background. If the process was killed
 * outright the notification is gone with it and there is nothing to receive.
 */
class IncomingCallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val deliver: (String) -> Unit = { dmChannelId ->
            when (intent.action) {
                IncomingCallNotifier.ACTION_DECLINE ->
                    CallServicePlugin.deliverIncomingCallDecline(dmChannelId)
                // 1.1: answering straight from the shade — the page runs
                // acceptDmCall exactly as the in-app button does.
                IncomingCallNotifier.ACTION_ANSWER ->
                    CallServicePlugin.deliverIncomingCallAnswer(dmChannelId)
            }
        }
        when (intent.action) {
            IncomingCallNotifier.ACTION_DECLINE,
            IncomingCallNotifier.ACTION_ANSWER -> {}
            else -> return
        }
        // End the ring first: for Decline it is the whole effect; for Answer the
        // page tears the ring down too, but this makes sure the shade never keeps
        // showing a ring after either tap (best-effort either way).
        try {
            IncomingCallNotifier.cancel(context)
        } catch (_: Exception) {
            // Cancelling is best-effort; the delivery below is the part that matters.
        }
        try {
            val dmChannelId = intent.getStringExtra(IncomingCallNotifier.EXTRA_DM_CHANNEL_ID) ?: ""
            deliver(dmChannelId)
        } catch (e: Exception) {
            // A BroadcastReceiver throwing kills the process on some OEMs.
            Log.w("E2EIncomingCall", "could not deliver the ring action: ${e.message}")
        }
    }
}
