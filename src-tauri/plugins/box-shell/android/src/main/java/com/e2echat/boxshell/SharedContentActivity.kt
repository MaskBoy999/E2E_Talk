package com.e2echat.boxshell

import android.app.Activity
import android.content.Intent

/**
 * Share-into-app trampoline — 3.4, FEATURE_PLAN.md (Gallery → Share → app).
 *
 * A `Theme.NoDisplay` activity declared in the COMMITTED plugin manifest (the
 * generated `MainActivity` lives in `src-tauri/gen/`, which is not tracked, so
 * an intent-filter there would not survive `tauri android init`). On ACTION_SEND
 * it hands the intent to [BoxShellPlugin.stageShared] — text into process
 * memory, file bytes into the app's own cache — hops the real app forward, and
 * finishes. It never shows a window, never logs the shared content, and never
 * writes a message body to disk (the plan's rule for the inbound FIFO: file
 * data only, never message text).
 *
 * The page drains the FIFO on its next visibility change via
 * `sharedPending` / `sharedRead` / `sharedDiscard`.
 */
class SharedContentActivity : Activity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            BoxShellPlugin.stageShared(applicationContext, intent)
            val launch = packageManager.getLaunchIntentForPackage(packageName)
            if (launch != null) {
                launch.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                        or Intent.FLAG_ACTIVITY_SINGLE_TOP
                        or Intent.FLAG_ACTIVITY_CLEAR_TOP
                )
                startActivity(launch)
            }
        } catch (_: Exception) {
            // A broken share must never take the app down.
        } finally {
            finish()
        }
    }
}
