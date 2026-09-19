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
 * Tapping (or answering) launches the app; "Decline" dismisses the ring
 * without opening it. Requires `USE_FULL_SCREEN_INTENT` (declared in the plugin
 * manifest) and, on Android 13+, the user having granted POST_NOTIFICATIONS.
 */
object IncomingCallNotifier {

    private const val CHANNEL_ID = "e2e_incoming_call"
    private const val NOTIFICATION_ID = 4712

    const val ACTION_DECLINE = "com.e2echat.callservice.action.DECLINE"

    /** Show (or refresh) the ring notification. */
    fun show(context: Context, callerName: String, dmChannelId: String) {
        ensureChannel(context)

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
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("Incoming call")
            .setContentText("$callerName is calling…")
            .setSmallIcon(context.applicationInfo.icon)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(fullScreenIntent)
            // The full-screen intent is what makes this ring over the lock
            // screen instead of waiting quietly in the shade.
            .setFullScreenIntent(fullScreenIntent, true)
            .addAction(0, "Decline", declineIntent)

        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted (Android 13+): nothing we can do
            // from here; the in-app bar still lights up when the user returns.
        }
    }

    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Incoming calls",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Rings when someone calls you"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            enableVibration(true)
            setSound(
                ringtone,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build()
            )
        }
        manager.createNotificationChannel(channel)
    }
}

/** Handles the notification's "Decline" action (dismiss without opening the app). */
class IncomingCallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == IncomingCallNotifier.ACTION_DECLINE) {
            IncomingCallNotifier.cancel(context)
        }
    }
}
