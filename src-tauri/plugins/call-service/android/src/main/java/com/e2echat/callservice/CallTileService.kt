package com.e2echat.callservice

import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick Settings tile — 2.3, FEATURE_PLAN.md.
 *
 * The muscle-memory place for call controls: pull the shade down and mute,
 * without opening the app. Deliberately dumb: it reads the static booleans in
 * [CallServicePlugin] and forwards fixed verbs to the page through the exact
 * delivery path the notification's buttons already use
 * ([CallServicePlugin.deliverCallAction] / [deliverIncomingCallAnswer]) — the
 * socket, and therefore the call, lives in the WebView.
 *
 * Privacy rules this file exists to keep (R1/R2):
 *  - every `label` is a compile-time string literal ("Mute", "Unmute",
 *    "E2E Chat") — tile labels are rendered by the SystemUI/launcher process,
 *    which is an OS surface like a notification: never a channel name, never a
 *    caller name, never a nickname;
 *  - state is booleans only (`Tile.STATE_ACTIVE/INACTIVE/UNAVAILABLE`);
 *  - nothing here ever logs or transmits anything.
 *
 * The system re-attaches `onStartListening` whenever
 * [CallServicePlugin.requestTileUpdate] asks, which is why every state change
 * in that companion nudges the tile.
 */
class CallTileService : TileService() {

    override fun onStartListening() {
        refresh()
    }

    override fun onClick() {
        when {
            CallServicePlugin.sInCall -> {
                // In a call: Mute/Unmute — same verb, same guard, same page
                // path as the ongoing notification's button.
                try {
                    CallServicePlugin.deliverCallAction("mute")
                } catch (_: Exception) {
                    // Never throw out of onClick: the system unbinds the tile.
                }
                // The page answers with updateCallState → sMuted flips → the
                // listening state request re-renders our label.
                refresh()
            }
            CallServicePlugin.sRinging -> {
                // Ringing: one tap answers. Only the id we staged travels.
                try {
                    CallServicePlugin.deliverIncomingCallAnswer(CallServicePlugin.sRingingDmId)
                } catch (_: Exception) {
                }
                // Open through the package's launch intent — this plugin
                // module has no class-level dependency on the app module
                // (com.e2echat.app.MainActivity does not resolve from here),
                // and the launch intent is the same path the notification uses.
                try {
                    val launch = packageManager.getLaunchIntentForPackage(packageName)
                    if (launch != null) {
                        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        startActivityAndCollapse(launch)
                    }
                } catch (_: Exception) {
                }
            }
            else -> {
                // Not in a call: open the app.
                try {
                    val launch = packageManager.getLaunchIntentForPackage(packageName)
                    if (launch != null) {
                        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivityAndCollapse(launch)
                    }
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun refresh() {
        val tile = qsTile ?: return
        when {
            CallServicePlugin.sInCall -> {
                tile.state = if (CallServicePlugin.sMuted) Tile.STATE_INACTIVE else Tile.STATE_ACTIVE
                tile.label = if (CallServicePlugin.sMuted) UNMUTE_LABEL else MUTE_LABEL
            }
            CallServicePlugin.sRinging -> {
                tile.state = Tile.STATE_ACTIVE
                tile.label = ANSWER_LABEL
            }
            else -> {
                tile.state = Tile.STATE_UNAVAILABLE
                tile.label = IDLE_LABEL
            }
        }
        tile.updateTile()
    }

    companion object {
        // The ONLY strings the tile ever shows. Literals by design — see the
        // class doc: SystemUI renders these, so they are an OS surface.
        private const val IDLE_LABEL = "E2E Chat"
        private const val MUTE_LABEL = "Mute"
        private const val UNMUTE_LABEL = "Unmute"
        private const val ANSWER_LABEL = "Answer"
    }
}
