package com.e2echat.callservice

import android.app.Activity
import android.app.Application
import android.app.PictureInPictureParams
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.util.Rational
import android.webkit.WebView
import java.lang.ref.WeakReference

/**
 * Picture-in-picture for a video tile — natively, because the WebView cannot do
 * it.
 *
 * The desktop box pops a tile out with `HTMLVideoElement.requestPictureInPicture()`
 * (`static/voice.js` → `startPiPForTile`). That API **does not exist in Android's
 * system WebView** (caniwebview tracks it as unsupported in WebView on every
 * version, while Chrome-for-Android got it in 105 — a different embedding), so on
 * a phone `document.pictureInPictureEnabled` is false and the button said "PiP not
 * supported in this browser".
 *
 * Android's own answer is *activity* PiP: the system shrinks the whole activity
 * into a small always-on-top window. That is exactly the primitive we want, and
 * the page does the rest — it lifts the chosen tile into a body-level, full-viewport
 * wrapper (the same `.voice-fs-wrap` the app's own fullscreen uses, so rotation and
 * mirror come along unchanged) and hides everything else. What the PiP window then
 * shows is the tile, at the tile's own aspect ratio.
 *
 * ## The pause, and why [keepAwake] exists
 *
 * Entering PiP **pauses the activity** (that is the documented lifecycle — the
 * activity is paused but still visible), and wry answers every pause by pausing
 * the WebView: `WryActivity.onPause` → `mWebView.onPause()`. A paused WebView
 * stops processing the page — including layout and painting — while the Android
 * view is still resized to the PiP window. The result is that the page is never
 * laid out for the small window, so the window kept showing a *crop of the
 * full-screen layout*: the reported "PiP opens a corner of the app instead of the
 * feed". And because the page was not running at all, no page-side fix could
 * touch it — the page's own "is the window still open?" polling never even ticked,
 * which is why an earlier attempt (adding entry grace to that polling) changed
 * nothing.
 *
 * So this file undoes exactly that one pause, for exactly as long as the window is
 * up: the page must keep laying out and drawing for the PiP window to show the
 * feed, which is the entire point of PiP. It is put back to sleep when the window
 * goes away, because a page that keeps running while the app is in the background
 * is precisely what the pause is for.
 *
 * Two Android rules shape the rest of this file:
 *   * the activity must declare `android:supportsPictureInPicture="true"`, or
 *     `enterPictureInPictureMode` throws. `gen/android/` is generated and wiped by
 *     `tauri android init`, so the attribute is contributed by the plugin's own
 *     manifest through manifest merging instead (see
 *     `android/src/main/AndroidManifest.xml`);
 *   * there is no public "leave PiP" call — the user's close/expand button is the
 *     normal way out, and bringing the task back to the front is the only
 *     programmatic equivalent.
 */
object Pip {

    private const val TAG = "E2EPip"

    /**
     * Android rejects an aspect ratio outside `2.39:1` … `1:2.39`. The bounds here
     * are a hair inside that range so a rounded ratio can never land exactly on
     * the limit and be refused.
     */
    private const val MIN_RATIO = 0.4195
    private const val MAX_RATIO = 2.38

    private const val DEFAULT_RATIO = 16.0 / 9.0

    /**
     * How long after a PiP request the next activity pause is assumed to be *that*
     * PiP entry. Without it a stale request could wake the WebView on an unrelated
     * pause much later (the user pressing home, say), which is the opposite of
     * what wry's pause is for. Entering PiP pauses the activity within a frame or
     * two of the call, so this only has to cover the transition.
     */
    private const val ARM_WINDOW_MS = 3000L

    /** The activity whose PiP entry we are waiting to catch. */
    @Volatile
    private var armed: WeakReference<Activity>? = null

    @Volatile
    private var armedAt = 0L

    /** The activity whose WebView we force-resumed, so its pause can be undone. */
    @Volatile
    private var awake: WeakReference<Activity>? = null

    /**
     * The page to keep awake. Weak, like everything else the plugin holds: the
     * WebView belongs to the activity, and a PiP session is never a reason to keep
     * either of them alive.
     */
    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    @Volatile
    private var hooked = false

    /**
     * The whole session state machine, because there is nowhere else to see it.
     *
     * A plugin cannot override `Activity.onPictureInPictureModeChanged`, so the
     * only PiP-relevant signal available from outside is the plain activity
     * lifecycle — and it is enough:
     *
     *   * **paused** — the activity just entered PiP. wry's `WebView.onPause()` has
     *     already run by the time this is dispatched (it is called from
     *     `Activity.onPause`, and lifecycle callbacks are dispatched after it), so
     *     this is the first moment undoing it sticks.
     *   * **resumed** — the window was expanded, or closed and the app reopened.
     *     Either way it is gone and the WebView's resume is the framework's again.
     *   * **stopped** — the window was closed (the task went away). Our resume was
     *     only ever bought for a window the user can see, so put the page back to
     *     sleep.
     */
    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityPaused(activity: Activity) {
            if (!isArmedNow(activity)) return
            keepAwake(activity)
        }

        override fun onActivityResumed(activity: Activity) {
            // Back to full screen: the window is gone, and if we resumed the page
            // ourselves, the framework's resume has just done it properly.
            if (matches(awake, activity)) awake = null
            if (matches(armed, activity)) armed = null
        }

        override fun onActivityStopped(activity: Activity) {
            if (matches(armed, activity)) armed = null
            if (!matches(awake, activity)) return
            awake = null
            putToSleep()
        }

        override fun onActivityDestroyed(activity: Activity) {
            if (matches(awake, activity)) awake = null
            if (matches(armed, activity)) armed = null
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

        override fun onActivityStarted(activity: Activity) {}

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    }

    private fun matches(ref: WeakReference<Activity>?, activity: Activity): Boolean =
        ref != null && ref.get() === activity

    private fun isArmedNow(activity: Activity): Boolean =
        matches(armed, activity) && (SystemClock.uptimeMillis() - armedAt) <= ARM_WINDOW_MS

    private fun hook(activity: Activity) {
        if (hooked) return
        hooked = true
        try {
            activity.application.registerActivityLifecycleCallbacks(lifecycle)
        } catch (e: Exception) {
            Log.w(TAG, "could not watch the lifecycle for the PiP window: ${e.message}")
        }
    }

    /**
     * Undo wry's `WebView.onPause()` for the PiP window.
     *
     * Posted rather than called inline: the pause this is answering arrived in the
     * same traversal, and a `WebView` state flip is only meaningful once that has
     * been left behind.
     */
    private fun keepAwake(activity: Activity) {
        val webView = webViewRef?.get()
        armed = null
        if (webView == null) {
            Log.w(TAG, "no WebView to keep awake; the PiP window will show a crop")
            return
        }
        awake = WeakReference(activity)
        webView.post {
            try {
                webView.onResume()
            } catch (e: Exception) {
                Log.w(TAG, "could not keep the page awake for the PiP window: ${e.message}")
            }
        }
    }

    /** The window is gone: let the page sleep like any backgrounded app again. */
    private fun putToSleep() {
        val webView = webViewRef?.get() ?: return
        webView.post {
            try {
                webView.onPause()
            } catch (e: Exception) {
                Log.w(TAG, "could not put the page back to sleep: ${e.message}")
            }
        }
    }

    /**
     * Shrink the activity into a PiP window with the given aspect ratio.
     *
     * Returns whether the system accepted the request. A `false` is normal: an
     * OEM may refuse PiP, the user may have disabled it for the app, or the
     * activity may not be in a state where it can enter. The page treats that as
     * "PiP did not open" and puts the tile back.
     *
     * [webView] is the page that has to stay awake for the window to be anything
     * other than a crop — see the class doc.
     */
    fun enter(activity: Activity, aspectRatio: Double, webView: WebView?): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val ratio = if (aspectRatio.isFinite() && aspectRatio > 0) aspectRatio else DEFAULT_RATIO
        val clamped = ratio.coerceIn(MIN_RATIO, MAX_RATIO)
        // Arm *before* asking, and disarm if the system says no. The activity pause
        // that entering PiP causes is dispatched on the main thread, and this
        // command is not necessarily running on it — arming afterwards could miss
        // the very pause this is meant to catch, leaving the window showing a
        // crop and nothing in the log to say why.
        webViewRef = if (webView != null) WeakReference(webView) else null
        hook(activity)
        armed = WeakReference(activity)
        armedAt = SystemClock.uptimeMillis()

        val entered = try {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational((clamped * 1000).toInt(), 1000))
                .build()
            val result = activity.enterPictureInPictureMode(params)
            Log.i(TAG, "enterPictureInPictureMode(${clamped}) -> $result")
            result
        } catch (e: Exception) {
            // Overwhelmingly: the activity is missing
            // android:supportsPictureInPicture, or the ratio was refused.
            Log.w(TAG, "could not enter picture-in-picture: ${e.message}")
            false
        }

        // Nothing was entered, so nothing is going to pause for it.
        if (!entered) armed = null
        return entered
    }

    /**
     * Whether the activity is *currently* in a PiP window.
     *
     * Exposed to the page as `pipState`, but deliberately not what the page uses
     * to decide the window is still up: this reads the activity's delivered
     * picture-in-picture flag, which flips only after the activity's pause — it
     * reports `false` while the window is still opening. `static/voice.js` keys
     * off the viewport instead, and only ever uses this as a hint.
     */
    fun isActive(activity: Activity): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        return try {
            activity.isInPictureInPictureMode
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Leave PiP by bringing the task back to the front.
     *
     * Best-effort by necessity — the platform exposes no "exit PiP" API, and the
     * launched intent is the documented way to restore the full-screen window. If
     * it does nothing, the page simply keeps the tile in the PiP window until the
     * user closes it, which is still correct behaviour.
     */
    fun exit(activity: Activity) {
        try {
            val launch = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
            if (launch == null) {
                Log.w(TAG, "no launch intent; the user will have to close the PiP window")
                return
            }
            // REORDER_TO_FRONT, not a new task: the app is already running and
            // singleTask, so this raises *this* task (ending PiP) rather than
            // starting a second one.
            launch.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            activity.startActivity(launch)
        } catch (e: Exception) {
            Log.w(TAG, "could not leave picture-in-picture: ${e.message}")
        }
    }
}
