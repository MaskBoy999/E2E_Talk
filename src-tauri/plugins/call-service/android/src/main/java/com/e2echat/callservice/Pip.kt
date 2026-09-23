package com.e2echat.callservice

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Intent
import android.os.Build
import android.util.Log
import android.util.Rational

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
 * shows is the tile, at the tile's own aspect ratio, with the compositor drawing
 * the live feed — no canvas, no per-frame JS.
 *
 * Two Android rules shape this file:
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
     * Shrink the activity into a PiP window with the given aspect ratio.
     *
     * Returns whether the system accepted the request. A `false` is normal: an
     * OEM may refuse PiP, the user may have disabled it for the app, or the
     * activity may not be in a state where it can enter. The page treats that as
     * "PiP did not open" and puts the tile back.
     */
    fun enter(activity: Activity, aspectRatio: Double): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val ratio = if (aspectRatio.isFinite() && aspectRatio > 0) aspectRatio else DEFAULT_RATIO
        val clamped = ratio.coerceIn(MIN_RATIO, MAX_RATIO)
        return try {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational((clamped * 1000).toInt(), 1000))
                .build()
            val entered = activity.enterPictureInPictureMode(params)
            Log.i(TAG, "enterPictureInPictureMode(${clamped}) -> $entered")
            entered
        } catch (e: Exception) {
            // Overwhelmingly: the activity is missing
            // android:supportsPictureInPicture, or the ratio was refused.
            Log.w(TAG, "could not enter picture-in-picture: ${e.message}")
            false
        }
    }

    /**
     * Whether the activity is *currently* in a PiP window.
     *
     * The page polls this while a session is up instead of waiting for a
     * lifecycle callback: PiP pauses the activity (so wry calls
     * `WebView.onPause`), which is precisely when a JS callback might not run, and
     * `isInPictureInPictureMode` is a cheap local read.
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
