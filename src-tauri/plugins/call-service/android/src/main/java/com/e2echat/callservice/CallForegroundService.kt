package com.e2echat.callservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the process (and therefore the WebView's WebRTC connection and mic
 * capture) alive while a call is in progress, with an ongoing notification the
 * user can tap to return to the call.
 *
 * Started/stopped by [CallServicePlugin]; Android requires that a
 * `mediaCall`-type foreground service is created from a foreground context.
 */
class CallForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.e2echat.callservice.action.START"
        const val ACTION_STOP = "com.e2echat.callservice.action.STOP"
        const val EXTRA_CHANNEL_NAME = "channelName"

        private const val CHANNEL_ID = "e2e_call"
        private const val NOTIFICATION_ID = 4711
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        val channelName = intent?.getStringExtra(EXTRA_CHANNEL_NAME) ?: "Voice call"
        ensureChannel()
        val notification = buildNotification(channelName)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_CALL
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // If Android kills us under memory pressure, come back rather than
        // silently dropping audio mid-call.
        return START_STICKY
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Voice calls",
            NotificationManager.IMPORTANCE_LOW // ongoing, not an alert
        ).apply {
            description = "Shown while you are in a voice call"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(channelName: String): Notification {
        // Tapping the notification reopens the app (single-activity app).
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launch?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("E2E Chat")
            .setContentText("In call — $channelName")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        if (contentIntent != null) builder.setContentIntent(contentIntent)
        return builder.build()
    }
}
