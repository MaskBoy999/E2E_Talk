package com.e2echat.callservice

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.lang.ref.WeakReference

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

    /**
     * The incoming-call vibration, in `navigator.vibrate` shape
     * `[buzz, pause, buzz, …]` ms — Settings → Voice → Haptics. The notification
     * channel is created from it, because a channel's vibration pattern is fixed
     * at creation (see IncomingCallNotifier). Null means an older page: the
     * app's default ring pattern is used, so the ring still buzzes.
     */
    var vibratePattern: List<Int>? = null

    /**
     * F2 (FEATURE_PLAN.md): honour the page's "hide message content in
     * notifications" preference (notifContentHidden). When true, the ring is
     * posted WITHOUT the caller's name and at lock-screen visibility PRIVATE,
     * so the identity never reaches the lock screen or Android's notification
     * history — the durable OS-held copies the FBI recovered Signal previews
     * from. Null/absent (older cached page) keeps the named ring.
     */
    var hideIdentity: Boolean? = null
}

/**
 * `updateCallState` — the current mute/deafen flags (for the ongoing
 * notification's action labels) plus the media types, which the service
 * re-applies alongside the labels.
 */
@InvokeArg
class UpdateCallStateArgs {
    var muted: Boolean? = null
    var deafened: Boolean? = null
    var mediaTypes: List<String>? = null
}

/** `enterPip` — the tile's aspect ratio, so the PiP window has no black bars. */
@InvokeArg
class PipArgs {
    var aspectRatio: Double? = null
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

    /**
     * Also mirror the device's playback ("share app audio"). Nullable because
     * the page may not send it at all, which means off — see `withAudio == true`
     * at the call site rather than a non-null default, so an older page cannot
     * silently turn it on.
     */
    var withAudio: Boolean? = null
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

    companion object {
        /** Same tag as ScreenCapture.kt, so one logcat filter shows the flow. */
        private const val SCREEN_TAG = "E2EScreenCapture"

        /** The app's default ring cue (Settings → Voice → Haptics default). */
        private val DEFAULT_RING_PATTERN = longArrayOf(150, 80, 150)

        /**
         * The live plugin instance, so the incoming-call notification's **Decline**
         * action can reach the page.
         *
         * Declining is delivered to a `BroadcastReceiver`, which Tauri constructs
         * itself and which therefore has no plugin reference. Without a way back
         * to the page the action can only dismiss the notification — which is
         * exactly what it used to do, leaving the caller ringing.
         *
         * A `WeakReference` because the plugin belongs to the activity: if the app
         * is torn down the notification goes with it, and a strong reference here
         * would keep a dead plugin (and its activity) alive instead.
         */
        @Volatile
        private var instance: WeakReference<CallServicePlugin>? = null

        /**
         * Called from [IncomingCallActionReceiver] when the user declines from the
         * notification. Safe to call at any time: with no live plugin (or no live
         * page) it is a no-op, and it never throws — an exception escaping a
         * receiver's `onReceive` can take the process down.
         */
        fun deliverIncomingCallDecline(dmChannelId: String) {
            try {
                instance?.get()?.sendDeclineToPage(dmChannelId)
            } catch (e: Exception) {
                android.util.Log.w(SCREEN_TAG, "could not deliver the decline: ${e.message}")
            }
        }

        /**
         * Called from [CallActionReceiver] when the user taps Mute / Deafen /
         * Hang up on the ongoing call notification (1.1). `action` is one of
         * three fixed strings chosen by the receiver — never free-form input.
         */
        fun deliverCallAction(action: String) {
            try {
                instance?.get()?.sendCallActionToPage(action)
            } catch (e: Exception) {
                android.util.Log.w(SCREEN_TAG, "could not deliver the call action: ${e.message}")
            }
        }

        /** Same hand-off, for "Answer" tapped on the incoming-call ring (1.1). */
        fun deliverIncomingCallAnswer(dmChannelId: String) {
            try {
                instance?.get()?.sendAnswerToPage(dmChannelId)
            } catch (e: Exception) {
                android.util.Log.w(SCREEN_TAG, "could not deliver the answer: ${e.message}")
            }
        }
    }

    init {
        // Registering a reference: nothing here can throw, so this stays off the
        // plugin-construction crash path (see screenCapture below).
        instance = WeakReference(this)
    }

    /**
     * The page's WebView, kept so a notification action delivered while the app is
     * backgrounded can call into it. Set by Tauri right after the webview exists.
     */
    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    override fun load(webView: WebView) {
        webViewRef = WeakReference(webView)
    }

    /**
     * End the ring, in the page, for a decline tapped in the notification shade.
     *
     * The socket — and therefore the call — lives in the WebView, so the decline
     * has to be executed there; `static/voice.js` exposes
     * `window.__e2eDeclineIncomingCall` for exactly this. `evaluateJavascript`
     * runs on the UI thread and does not need the app to be in the foreground, and
     * a manifest-declared receiver is delivered to a cached process (Android
     * unfreezes it for `onReceive`), so this works while the app is in the
     * background. The page guards on there actually being an incoming call, so a
     * stray tap on a dead notification does nothing.
     */
    private fun sendDeclineToPage(dmChannelId: String) {
        val webView = webViewRef?.get() ?: return
        val arg = jsStringLiteral(dmChannelId)
        try {
            webView.post {
                try {
                    webView.evaluateJavascript(
                        "window.__e2eDeclineIncomingCall && window.__e2eDeclineIncomingCall(" + arg + ")",
                        null
                    )
                } catch (e: Exception) {
                    android.util.Log.w(SCREEN_TAG, "decline JS failed: ${e.message}")
                }
            }
        } catch (e: Exception) {
            android.util.Log.w(SCREEN_TAG, "could not reach the page: ${e.message}")
        }
    }

    /**
     * Forward a notification action tap to the page
     * (`window.__e2eCallAction("mute|deafen|hangup")`). Same delivery rules as
     * [sendDeclineToPage]: runs on the UI thread without the app in the
     * foreground, and a stale tap is filtered out by the page's own guards.
     */
    private fun sendCallActionToPage(action: String) {
        val webView = webViewRef?.get() ?: return
        val arg = jsStringLiteral(action)
        try {
            webView.post {
                try {
                    webView.evaluateJavascript(
                        "window.__e2eCallAction && window.__e2eCallAction(" + arg + ")",
                        null
                    )
                } catch (e: Exception) {
                    android.util.Log.w(SCREEN_TAG, "call action JS failed: ${e.message}")
                }
            }
        } catch (e: Exception) {
            android.util.Log.w(SCREEN_TAG, "could not reach the page: ${e.message}")
        }
    }

    /** Forward an "Answer" tap (`window.__e2eAcceptIncomingCall`). */
    private fun sendAnswerToPage(dmChannelId: String) {
        val webView = webViewRef?.get() ?: return
        val arg = jsStringLiteral(dmChannelId)
        try {
            webView.post {
                try {
                    webView.evaluateJavascript(
                        "window.__e2eAcceptIncomingCall && window.__e2eAcceptIncomingCall(" + arg + ")",
                        null
                    )
                } catch (e: Exception) {
                    android.util.Log.w(SCREEN_TAG, "answer JS failed: ${e.message}")
                }
            }
        } catch (e: Exception) {
            android.util.Log.w(SCREEN_TAG, "could not reach the page: ${e.message}")
        }
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
     * 1.1 (FEATURE_PLAN.md): refresh the ongoing call notification's action
     * labels (Mute/Unmute, Deafen/Undeafen) from the page's real state, and
     * re-apply the foreground-service types with it so a state refresh can
     * never lower them. Sent on every local mute/deafen change and on join.
     */
    @Command
    fun updateCallState(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateCallStateArgs::class.java)
        val intent = Intent(activity, CallForegroundService::class.java).apply {
            action = CallForegroundService.ACTION_UPDATE
            putExtra(CallForegroundService.EXTRA_MUTED, args.muted == true)
            putExtra(CallForegroundService.EXTRA_DEAFENED, args.deafened == true)
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
            invoke.reject("Could not update the call state: ${e.message}")
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
            screenCapture.prepare(ch, args.maxHeight ?: 480, args.fps ?: 10, args.withAudio == true)
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
                args.dmChannelId ?: "",
                // `List<Int>` has no toLongArray() — every pattern is in ms, well
                // inside Int, and VibrationEffect wants longs.
                args.vibratePattern?.map { it.toLong() }?.toLongArray() ?: DEFAULT_RING_PATTERN,
                args.hideIdentity == true
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

    /**
     * Shrink the activity into a picture-in-picture window — the Android route to
     * the desktop box's `requestPictureInPicture()`, which the system WebView does
     * not implement. See [Pip].
     *
     * Resolves `{ inPip }` rather than rejecting: "the system would not give us a
     * PiP window" is a normal outcome (an OEM may refuse, or the user may have it
     * off for the app), and the page needs to put the tile back either way.
     *
     * The WebView goes along because the window shows the *activity*, and entering
     * PiP pauses it — wry pauses the WebView with it, which would leave the window
     * showing a crop of the full-screen page. [Pip] undoes that one pause; the
     * page has to be handed to it for that.
     */
    @Command
    fun enterPip(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(PipArgs::class.java)
        } catch (_: Exception) {
            PipArgs()
        }
        val entered = Pip.enter(activity, args.aspectRatio ?: (16.0 / 9.0), webViewRef?.get())
        val out = JSObject()
        out.put("inPip", entered)
        invoke.resolve(out)
    }

    /**
     * Whether the activity is in a PiP window *right now*. The page polls this
     * while a session is up: the user can close the window with the system's own
     * button, which is not something we get a callback for, and PiP pauses the
     * activity (so a JS callback is not guaranteed to run at that moment).
     */
    @Command
    fun pipState(invoke: Invoke) {
        val out = JSObject()
        out.put("inPip", Pip.isActive(activity))
        invoke.resolve(out)
    }

    /** Best-effort "leave PiP" — see [Pip.exit]. Always resolves. */
    @Command
    fun exitPip(invoke: Invoke) {
        try {
            Pip.exit(activity)
        } catch (e: Exception) {
            android.util.Log.w(SCREEN_TAG, "exitPip failed: ${e.message}")
        }
        invoke.resolve()
    }

    /**
     * The phone's ringer mode + do-not-disturb state.
     *
     * The notification is already subject to both (the system owns its channel),
     * but the app rings *itself* through WebAudio as well, and WebAudio has no idea
     * a phone can be on silent. `static/voice.js` reads this before it rings so an
     * incoming call can't sound off on a muted phone. See [AudioProfile].
     */
    @Command
    fun getAudioProfile(invoke: Invoke) {
        invoke.resolve(AudioProfile.read(activity))
    }
}

/**
 * A JS string literal for `evaluateJavascript`, escaped here rather than via a
 * JSON dependency so a hostile/odd channel id can never break out of the literal
 * (or terminate it early with a stray `</script>`).
 */
private fun jsStringLiteral(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) {
        when {
            c == '\\' -> sb.append("\\\\")
            c == '"' -> sb.append("\\\"")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\u2028' -> sb.append("\\u2028")
            c == '\u2029' -> sb.append("\\u2029")
            c == '<' -> sb.append("\\u003c")
            c.code < 0x20 -> sb.append(String.format("\\u%04x", c.code))
            else -> sb.append(c)
        }
    }
    return sb.append("\"").toString()
}
