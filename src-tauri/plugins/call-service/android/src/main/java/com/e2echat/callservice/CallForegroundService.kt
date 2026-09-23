package com.e2echat.callservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Keeps the process (and therefore the WebView's WebRTC connection and mic
 * capture) alive while a call is in progress, with an ongoing notification the
 * user can tap to return to the call.
 *
 * The *type* matters as much as the service. Android 14+ requires the type(s)
 * the service actually uses to be declared here (see the plugin manifest) and
 * passed to `startForeground`, and microphone/camera capture is revoked as soon
 * as the app leaves the foreground **unless** the running service claims the
 * matching type. Claiming `phoneCall` alone therefore looked fine (the service
 * ran, the notification showed) while the call went silent ten seconds after the
 * screen went off. The types are (re)applied from `mediaTypes` on every start and
 * `ACTION_UPDATE`, which the JS side sends whenever camera or screen sharing is
 * toggled mid-call.
 */
class CallForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.e2echat.callservice.action.START"
        const val ACTION_STOP = "com.e2echat.callservice.action.STOP"
        const val ACTION_UPDATE = "com.e2echat.callservice.action.UPDATE"
        const val EXTRA_CHANNEL_NAME = "channelName"

        // 1.1 (FEATURE_PLAN.md): the current mute/deafen flags, so the ongoing
        // notification's action labels can say "Unmute" while muted. Sent only
        // on state updates; absent means keep the previous state.
        const val EXTRA_MUTED = "muted"
        const val EXTRA_DEAFENED = "deafened"

        /** Action taps handled by [CallActionReceiver], not by the service. */
        const val ACTION_MUTE = "com.e2echat.callservice.action.MUTE"
        const val ACTION_DEAFEN = "com.e2echat.callservice.action.DEAFEN"
        const val ACTION_HANGUP = "com.e2echat.callservice.action.HANGUP"

        /** Media the call is carrying: "audio" (always), "camera", "screen". */
        const val EXTRA_MEDIA_TYPES = "mediaTypes"

        private const val CHANNEL_ID = "e2e_call"
        private const val NOTIFICATION_ID = 4711
        private const val TAG = "E2ECallService"

        /**
         * Foreground-service types for the media a call is using.
         *
         * `phoneCall` is always included: it is what makes Android treat this as
         * an ongoing call for audio-focus / do-not-disturb purposes, and
         * `MANAGE_OWN_CALLS` (declared in the plugin manifest) is all it needs.
         * `microphone` is what actually keeps capture alive in the background.
         */
        fun buildTypeMask(mediaTypes: List<String>): Int {
            var mask = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
            if (mediaTypes.contains("audio")) {
                mask = mask or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            if (mediaTypes.contains("camera")) {
                mask = mask or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            if (mediaTypes.contains("screen")) {
                mask = mask or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            }
            return mask
        }
    }

    /** The type mask currently applied, so an update can tell whether it changed. */
    private var appliedMask = 0

    /** Current self state — drives the notification's action labels (1.1). */
    private var muted = false
    private var deafened = false

    // ── Audio focus (1.4, FEATURE_PLAN.md) ────────────────────────────────
    // Held for the length of the call so the user's music pauses when the
    // call starts and comes back on hang-up, instead of the app talking over
    // whatever is playing. GAIN_TRANSIENT (not GAIN) is what tells Android to
    // hand playback back to the previous owner after abandonAudioFocus().
    // Kept as fields so the abandon targets the exact request/listener pair.
    private val focusListener = AudioManager.OnAudioFocusChangeListener { /* the call never yields mid-ring: nothing to do on loss */ }
    private var focusRequest: AudioFocusRequest? = null
    private var focusHeld = false

    private fun requestAudioFocus() {
        if (focusHeld) return
        val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        focusHeld = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            focusRequest = req
            am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    private fun abandonAudioFocus() {
        if (!focusHeld) return
        focusHeld = false
        val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { am.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(focusListener)
        }
    }

    override fun onDestroy() {
        abandonAudioFocus()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        // F1 (FEATURE_PLAN.md): EXTRA_CHANNEL_NAME is still accepted — an
        // older cached page sends it — but it is NEVER displayed. It used to
        // carry a decrypted E2EE channel name into the ongoing notification,
        // i.e. into the Android shade and notification history, which sit
        // outside the encryption boundary (the FBI/Signal-preview case).
        // The notification text is now a constant.
        val mediaTypes = intent?.getStringArrayListExtra(EXTRA_MEDIA_TYPES) ?: arrayListOf("audio")

        // 1.1: state updates carry the current flags so the action labels match
        // reality. Absent (plain start/media update) keeps the last known state.
        if (intent?.hasExtra(EXTRA_MUTED) == true) muted = intent.getBooleanExtra(EXTRA_MUTED, false)
        if (intent?.hasExtra(EXTRA_DEAFENED) == true) deafened = intent.getBooleanExtra(EXTRA_DEAFENED, false)

        // An update that arrives before the service was ever foregrounded (a
        // camera/screen toggle racing the connect) is just a start — and an
        // update whose mask is unchanged costs nothing but a re-post.
        requestAudioFocus()
        ensureChannel()
        val notification = buildNotification()
        applyTypes(mediaTypes, notification)
        // If Android kills us under memory pressure, come back rather than
        // silently dropping audio mid-call.
        return START_STICKY
    }

    /**
     * Put the service in the foreground with the types the call needs, falling
     * back to the safest smaller set rather than taking the call down.
     *
     * A type can be refused at runtime for reasons the app cannot see coming —
     * the camera permission revoked after the call started, an OEM that dislikes
     * a combination, `RECORD_AUDIO` withdrawn mid-call — and `startForeground`
     * throws for all of them. Losing the whole service (and with it the process
     * holding the WebRTC connection) would be a much worse outcome than losing
     * one type, so each candidate is tried in turn and the first one Android
     * accepts is kept.
     */
    private fun applyTypes(mediaTypes: List<String>, notification: Notification) {
        val requested = buildTypeMask(mediaTypes)
        val candidates = listOf(
            requested,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
        ).distinct()

        for (candidate in candidates) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, notification, candidate)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
                if (candidate != requested) {
                    Log.w(TAG, "foreground types $requested refused; running with $candidate")
                }
                appliedMask = candidate
                return
            } catch (e: Exception) {
                Log.w(TAG, "startForeground(type=$candidate) failed: ${e.message}")
            }
        }
        // Nothing worked: stop rather than run a call with no foreground service
        // at all (which Android would kill at will, mid-call and silently).
        Log.e(TAG, "no foreground-service type was accepted; stopping the call service")
        stopForegroundCompat()
        stopSelf()
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

    private fun buildNotification(): Notification {
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
            // F1: constant text — never a channel name (see onStartCommand).
            .setContentText("In a call")
            // Silhouette, not the launcher icon — see IncomingCallNotifier:
            // a small icon is an alpha mask, so the full-colour app icon came
            // out as a white blob in the status bar.
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        // 1.1 (FEATURE_PLAN.md): control the call from the shade. The tap goes
        // to CallActionReceiver (verb names only — nothing user-visible or E2EE
        // travels through that path), the page applies it, and sends
        // updateCallState so the labels flip on the next post. Icon 0, same as
        // the ring's actions: SystemUI does not render small icons on compact
        // notification actions anyway.
        builder
            .addAction(0, if (muted) "Unmute" else "Mute", actionPendingIntent(ACTION_MUTE, 21))
            .addAction(0, if (deafened) "Undeafen" else "Deafen", actionPendingIntent(ACTION_DEAFEN, 22))
            .addAction(0, "Hang up", actionPendingIntent(ACTION_HANGUP, 23))

        if (contentIntent != null) builder.setContentIntent(contentIntent)
        return builder.build()
    }

    /** Immutable broadcast PendingIntent for one notification action tap. */
    private fun actionPendingIntent(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getBroadcast(
            this,
            requestCode,
            Intent(this, CallActionReceiver::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
}
