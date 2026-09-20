package com.e2echat.boxshell

import android.app.Activity
import android.os.Build
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
 */
@TauriPlugin
class BoxShellPlugin(private val activity: Activity) : Plugin(activity) {

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
