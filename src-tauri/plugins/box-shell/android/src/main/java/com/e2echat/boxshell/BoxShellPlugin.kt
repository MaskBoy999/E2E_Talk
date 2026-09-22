package com.e2echat.boxshell

import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Window
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BackHandlerArgs {
    /**
     * Whether the page wants the hardware Back button routed to it. `false`
     * restores Android's default (Back finishes the activity), which is what the
     * page asks for when it is showing something that genuinely has no "back"
     * (the setup/address screen, for instance).
     */
    var active: Boolean = true
}

@InvokeArg
class VibrateArgs {
    /**
     * Alternating buzz/pause durations in milliseconds, exactly the shape
     * `navigator.vibrate` takes: `[buzz, pause, buzz, …]`. The first entry is
     * always a buzz. An empty array — or one that is all zeros — stops whatever
     * is vibrating, which is what `navigator.vibrate(0)` means.
     */
    var pattern: List<Int> = emptyList()
}

/**
 * The Android shell half of the box.
 *
 * `activity` is the single `MainActivity` — a `TauriActivity`, so it is an
 * `AppCompatActivity` and therefore has an `OnBackPressedDispatcher`.
 *
 * Both features are re-applied from `onResume` as well as from the commands:
 * Android restores the system bars after a screen-off/on cycle, a task switch,
 * or a transient swipe that timed out, and the page cannot see all of those.
 * Re-applying is idempotent, so it is safe to do whenever the activity comes
 * back to the front.
 *
 * It also carries the two device duties the WebView cannot perform for itself:
 * `vibrate` (Chromium dropped the Vibration API on Android, so every haptic cue
 * in the app was silently dead inside the box whatever the settings said) and
 * `clearNotifications` (the shade must be empty on return, minus an ongoing
 * call).
 */
@TauriPlugin
class BoxShellPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /**
         * The ongoing "In call" notification, owned by the call-service plugin
         * (`CallForegroundService.NOTIFICATION_ID`). It has to survive
         * [clearNotifications]: while a call is up, that notification *is* the
         * call's presence in the shade and the way back into it. Keep the two
         * numbers in step if the call notification id ever moves.
         */
        private const val ONGOING_CALL_NOTIFICATION_ID = 4711
    }

    /** Whether the page currently wants the system bars hidden. */
    private var immersive = false

    /** Whether our back callback has been attached to the activity (once). */
    private var backInstalled = false

    /**
     * Routes Back to the page instead of finishing the activity.
     *
     * Registered disabled, so if the page never asks for it, or the app is
     * finishing, Android's own behaviour is untouched. Attaching this is what
     * *replaces* the default: the generated `TauriActivity` sets
     * `handleBackNavigation = false`, which means wry adds no callback at all,
     * so without this the system's default (finish) is all that exists.
     */
    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            // `Plugin.trigger` reaches the WebView's JS listeners. The page
            // closes its topmost layer and, if there was nothing to close,
            // invokes `exit` — see static/box-shell.js.
            trigger("box:back", JSObject())
        }
    }

    override fun onResume() {
        super.onResume()
        if (immersive) applyImmersive()
    }

    /** Hide the status + navigation bars; a swipe reveals them transiently. */
    @Command
    fun enterImmersive(invoke: Invoke) {
        immersive = true
        applyImmersive()
        invoke.resolve()
    }

    /** Show them again (e.g. the setup screen, where an address is typed). */
    @Command
    fun exitImmersive(invoke: Invoke) {
        immersive = false
        showBars()
        invoke.resolve()
    }

    /** Turn the Back interception on or off for the current screen. */
    @Command
    fun setBackHandler(invoke: Invoke) {
        val args = invoke.parseArgs(BackHandlerArgs::class.java)
        installBackCallback()
        backCallback.isEnabled = args.active && backInstalled
        invoke.resolve()
    }

    /**
     * Leave the app — what the page asks for when Back was pressed and nothing
     * was open. `finishAndRemoveTask` also drops the task from Recents, which is
     * what "closed the app" should look like; a plain `finish()` would leave the
     * entry behind to be resumed into.
     */
    @Command
    fun exit(invoke: Invoke) {
        invoke.resolve()
        activity.runOnUiThread {
            activity.finishAndRemoveTask()
        }
    }

    /**
     * Buzz the phone's real vibrator with a `navigator.vibrate`-shaped pattern.
     *
     * This command exists because the page cannot reach the hardware itself:
     * Chromium **disabled the Vibration API on Android in v79**, and left the
     * *interface* in place. So `navigator.vibrate` is defined, is not blocked,
     * returns `true` while the page is visible, and does nothing at all — every
     * cue (incoming call, ring→waiting, notification, and the "Test pattern"
     * buttons, which are exactly where a user goes to check) looked correct in a
     * browser and was dead inside the app.
     *
     * `VibrationEffect.createWaveform` takes the same alternating buzz/pause
     * array the page already builds, so a configured pattern plays as ONE
     * hardware waveform — no JS timers stringing pulses together, and no drift if
     * the WebView freezes mid-pattern (which is precisely when a call cue
     * matters).
     */
    @Command
    fun vibrate(invoke: Invoke) {
        val args = invoke.parseArgs(VibrateArgs::class.java)
        val timings = args.pattern.map { it.coerceAtLeast(0).toLong() }.toLongArray()
        val vibrator = vibrator()
        // No vibrator (an emulator, a tablet, a phone in a mode that reports
        // none) is not an error: the cue was best-effort to begin with.
        if (vibrator == null || !vibrator.hasVibrator()) {
            invoke.resolve()
            return
        }
        try {
            if (timings.isEmpty() || timings.all { it == 0L }) {
                vibrator.cancel()
            } else {
                vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
            }
            invoke.resolve()
        } catch (e: Exception) {
            // A refused vibration must never take the page down with it.
            invoke.reject(e.message ?: "vibrate failed")
        }
    }

    /**
     * Dismiss every notification this app posted, except the ongoing call.
     *
     * Coming back to the app means whatever was waiting has now been seen, so
     * the shade should be empty — the notifications that used to sit there for
     * good were ones the user had already read, and nothing could clear them
     * (the notification plugin's shim posts a plain object with no `close()`).
     * The in-call notification is deliberately left alone: while a call is up it
     * *is* the call's presence in the shade and the way back to it.
     */
    @Command
    fun clearNotifications(invoke: Invoke) {
        try {
            val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            manager?.activeNotifications?.forEach { status ->
                if (status.id != ONGOING_CALL_NOTIFICATION_ID) manager.cancel(status.id)
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "clearNotifications failed")
        }
    }

    /**
     * The device vibrator, through the manager that replaced the service in
     * Android 12 (API 31); the older service lookup is kept for API 29/30, which
     * this app still supports (`bundle.android.minSdkVersion` is 29).
     */
    private fun vibrator(): Vibrator? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            manager?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    } catch (e: Exception) {
        null
    }

    private fun window(): Window? = activity.window

    private fun installBackCallback() {
        if (backInstalled) return
        // Every Tauri mobile activity is an AppCompatActivity, so this holds —
        // but a plain Activity (a future Tauri change, or a different entry
        // activity) must not crash the app, it just loses the feature.
        val host = activity as? AppCompatActivity ?: return
        host.onBackPressedDispatcher.addCallback(host, backCallback)
        backInstalled = true
    }

    /**
     * `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` is the whole point: the user's
     * gesture — drag from the top of the screen, or up from the bottom — brings
     * the bar in for a moment, and it hides itself again. The default behaviour
     * would leave the bar on screen until the app hid it again.
     */
    private fun applyImmersive() {
        val window = window() ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Let the app draw into the notch/cutout area as well; otherwise the
            // cutout would keep a permanent black bar at the top of a phone that
            // has one, which is most of them.
            val attrs = window.attributes
            attrs.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            window.attributes = attrs
        }
        val controller = controller(window) ?: return
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun showBars() {
        val window = window() ?: return
        controller(window)?.show(WindowInsetsCompat.Type.systemBars())
    }

    private fun controller(window: Window): WindowInsetsControllerCompat? =
        WindowCompat.getInsetsController(window, window.decorView)
}
