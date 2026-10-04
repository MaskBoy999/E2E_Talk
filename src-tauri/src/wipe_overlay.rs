//! The **native** always-on "clear all app data" overlay (desktop).
//!
//! A tiny always-on-top window (`static/box-wipe.html`) that the shell creates
//! at launch and never navigates. It is the answer to the one question a
//! page-drawn control cannot answer: *how do you erase everything when no page
//! is running?*
//!
//! `static/app-overlay.js` — the old overlay — draws the same button **inside
//! the page**, which is enough on the happy path and useless in exactly the
//! states the control is for:
//!
//! * the WebView's **own error page** ("can't reach this page",
//!   `ERR_CONNECTION_REFUSED`) runs no script at all, so the button vanished
//!   the moment the saved host went away for good;
//! * a launch that paints a **blank or grey document** (a stale cache, a
//!   half-updated app, a failed boot) may never run one either;
//! * the watchdog workaround (`watch_closed_host` / `watch_page_alive` in
//!   `lib.rs`) navigates the window back to the bundled address screen so the
//!   in-page overlay exists again — but that *moves the user*, and it still
//!   depends on a page running.
//!
//! A second window does not depend on anything the main window does. It is
//! created here, anchored to the bottom-left of whichever app window is on
//! screen, and stays there while the main window shows the host's chat page,
//! Chromium's error page, a blank page, or the box's address screen.
//!
//! Two consequences worth stating plainly:
//!
//! * the button is **always** visible in the app — connected, disconnected,
//!   unreachable, blank — and only "Hide this button" removes it, for the rest
//!   of that run (`hidden` in [`super::AppState`] is memory-only, so reopening
//!   the app always brings it back);
//! * **the wipe does not need the page either.** The page half is still asked
//!   for over [`WIPE_REQUESTED_EVENT`] (it can sign out server-side while the
//!   token exists), but the shell's half — the WebView's own storage through
//!   the platform, then the saved address and pinned certificate — runs
//!   regardless, which is what makes the button trustworthy when the app is
//!   already broken.
//!
//! Android has no second Tauri window to put the control in (see `open_setup`
//! in `lib.rs`), so there `static/app-overlay.js` still draws it, and the
//! address-screen watchdog still exists as the fallback for a dead host. The
//! shell half of the wipe is not desktop-only: `box:clear-connection` clears
//! the WebView's storage on every platform.

use super::{forget_connection, AppState, MAIN_LABEL, SETUP_LABEL};
use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The overlay window's label.
pub const LABEL: &str = "box-wipe";

/// The bundled page the overlay window loads (shared with `box-setup.html`:
/// `frontendDist` is the website directory, so shell pages live there too —
/// but this page is *only ever loaded by the shell's own window*, never by a
/// page the host serves).
const PAGE: &str = "box-wipe.html";

/// Evaluated in every desktop main/setup page **before any script of that page
/// runs**: tells the page that the shell draws the wipe control in its own
/// window, so `static/app-overlay.js` must not draw a second one in the same
/// corner. Absent on Android, where the page keeps drawing the only button.
pub const INIT_SCRIPT: &str = "window.__E2E_NATIVE_WIPE_OVERLAY__ = true;";

/// `box-wipe.html` asking the shell to do something. Events rather than app
/// commands, like every other page→shell request in this app: the overlay
/// page's capability (`capabilities/wipe-overlay.json`) grants it the event
/// channel and nothing else, so the control surface stays one-way.
const OPEN_EVENT: &str = "box:wipe-open";
const CLOSE_EVENT: &str = "box:wipe-close";
const HIDE_EVENT: &str = "box:wipe-hide";
const RUN_EVENT: &str = "box:wipe-run";

/// Shell → overlay page: `{open}` — the panel opened/closed, switch views.
const VIEW_EVENT: &str = "box:wipe-view";

/// Shell → main page: run the page half of the wipe (sign out server-side
/// while the token still exists; drop what JS can reach). The shell's own half
/// runs regardless — that is the point of the native button — so a page that
/// never answers is not an error.
const WIPE_REQUESTED_EVENT: &str = "box:wipe-requested";

/// Collapsed (button) and expanded (panel) logical sizes of the overlay, and
/// the gap to the bottom-left corner of the window it floats over.
const BUTTON_SIZE: (f64, f64) = (46.0, 46.0);
const PANEL_SIZE: (f64, f64) = (400.0, 280.0);
const MARGIN: f64 = 14.0;

/// How long the page half of a wipe gets before the shell finishes without it.
/// Long enough for one already-started `POST /api/logout`, short enough that
/// the address screen is back before the user wonders whether the click landed.
const PAGE_WIPE_GRACE_MS: u64 = 1500;

/// Create the overlay, wire its events and start keeping it in place. Called
/// once from `setup`, after the launch routing has created whichever window
/// this run starts on.
pub fn install(app: &tauri::AppHandle) {
    open(app);
    {
        let for_open = app.clone();
        app.listen(OPEN_EVENT, move |_| set_panel(&for_open, true));
    }
    {
        let for_close = app.clone();
        app.listen(CLOSE_EVENT, move |_| set_panel(&for_close, false));
    }
    {
        let for_hide = app.clone();
        app.listen(HIDE_EVENT, move |_| hide(&for_hide));
    }
    {
        let for_run = app.clone();
        app.listen(RUN_EVENT, move |_| wipe_everything(&for_run));
    }
    sync(app);

    // Backstop tick. The window events below cover moving, resizing, hiding and
    // showing, but a *display* change, a window drag the events missed, or a
    // path that shows the main window without telling us would otherwise leave
    // the button in the wrong place or hidden. This only ever calls `sync`,
    // which does nothing unless something actually changed.
    let for_tick = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        if for_tick.get_webview_window(LABEL).is_none() {
            return; // window closed, or the app is shutting down
        }
        sync(&for_tick);
    });
}

/// Create the overlay window if it does not exist yet, hidden.
///
/// `visible(false)` on purpose: [`sync`] shows it once there is a window to
/// anchor to and a place to put it, so a frame at the wrong spot is never seen.
fn open(app: &tauri::AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title("E2E Chat")
        .inner_size(BUTTON_SIZE.0, BUTTON_SIZE.1)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .closable(false)
        // The overlay renders one bundled page and must never go anywhere else:
        // same rule as the main window (`nav_allowlist` in `lib.rs`), applied to
        // the window that has the event capability. Anything that is not one of
        // the app's own pages — and not a local, network-free scheme — is
        // refused instead of loaded.
        .on_navigation(|url| {
            super::is_app_page(url) || !matches!(url.scheme(), "http" | "https")
        });
    // Same browser arguments as the main window: hardware-acceleration choice,
    // and the opt-in remote debugging port (`E2E_BOX_DEBUG_PORT`) that the box
    // tests attach to — without it the overlay is invisible to them.
    if let Some(args) = super::webview_browser_args(super::gpu_disabled(app)) {
        builder = builder.additional_browser_args(&args);
    }
    match builder.build() {
        Ok(_) => eprintln!("{LABEL}: overlay window created"),
        Err(e) => eprintln!("{LABEL}: could not create the overlay window: {e}"),
    }
}

/// The window the overlay floats over: whichever of the app's windows is on
/// screen — the main window first, then the separate setup window — or `None`
/// when every app window is hidden (close-to-tray) or minimized. Then the
/// overlay hides itself too, rather than floating over someone else's desktop.
fn anchor(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    [MAIN_LABEL, SETUP_LABEL].into_iter().find_map(|label| {
        let window = app.get_webview_window(label)?;
        let on_screen =
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
        on_screen.then_some(window)
    })
}

/// Where a [`MARGIN`] gap from the bottom-left corner of a window puts an
/// `overlay_size` window, in physical pixels, with the margin scaled to the
/// window's DPI factor. Pure, so the rule is unit-tested rather than argued
/// about.
fn position(
    anchor: (i32, i32),
    anchor_size: (u32, u32),
    overlay_size: (u32, u32),
    scale: f64,
) -> (i32, i32) {
    let margin = (MARGIN * scale).round() as i32;
    (
        anchor.0 + margin,
        anchor.1 + anchor_size.1 as i32 - overlay_size.1 as i32 - margin,
    )
}

/// Put the overlay where it belongs, at the size the current view needs, and
/// show it — or hide it when it must not be seen (hidden by the user, or no app
/// window on screen).
///
/// Cheap and idempotent; see [`install`] for the callers.
pub fn sync(app: &tauri::AppHandle) {
    let Some(overlay) = app.get_webview_window(LABEL) else {
        return;
    };
    // Show/hide only on a transition. This runs once a second as a backstop, and
    // a `show()` on an already-visible window is a ShowWindow call that can
    // re-activate it — which would pull focus out of the chat while the user is
    // typing. `is_visible()` exists for exactly this.
    let visible = overlay.is_visible().unwrap_or(false);
    let hidden = app
        .state::<AppState>()
        .wipe_overlay_hidden
        .lock()
        .map(|h| *h)
        .unwrap_or(false);
    let Some(anchor) = anchor(app) else {
        if visible {
            let _ = overlay.hide();
        }
        return;
    };
    if hidden {
        if visible {
            let _ = overlay.hide();
        }
        return;
    }

    let panel_open = app
        .state::<AppState>()
        .wipe_panel_open
        .lock()
        .map(|p| *p)
        .unwrap_or(false);
    let (width, height) = if panel_open { PANEL_SIZE } else { BUTTON_SIZE };
    let scale = anchor.scale_factor().unwrap_or(1.0);
    let wanted = (width * scale, height * scale);
    if overlay.inner_size().ok().map(|s| (s.width as f64, s.height as f64)) != Some(wanted) {
        let _ = overlay.set_size(tauri::LogicalSize::new(width, height));
    }

    let (Ok(anchor_pos), Ok(anchor_size), Ok(overlay_size)) = (
        anchor.outer_position(),
        anchor.outer_size(),
        overlay.outer_size(),
    ) else {
        return;
    };
    let wanted_position = position(
        (anchor_pos.x, anchor_pos.y),
        (anchor_size.width, anchor_size.height),
        (overlay_size.width, overlay_size.height),
        scale,
    );
    if overlay.outer_position().ok().map(|p| (p.x, p.y)) != Some(wanted_position) {
        let _ = overlay.set_position(tauri::PhysicalPosition::new(
            wanted_position.0,
            wanted_position.1,
        ));
    }
    if !visible {
        let _ = overlay.show();
    }
}

/// Open or close the overlay's panel: the shell owns the geometry and simply
/// tells the page which view it is in.
fn set_panel(app: &tauri::AppHandle, open: bool) {
    if let Ok(mut slot) = app.state::<AppState>().wipe_panel_open.lock() {
        *slot = open;
    }
    sync(app);
    let _ = app.emit_to(LABEL, VIEW_EVENT, serde_json::json!({ "open": open }));
    if !open {
        // Pressing the button gave keyboard focus to the overlay window; a
        // closed panel hands it back so the app keeps typing where it should.
        if let Some(anchor) = anchor(app) {
            let _ = anchor.set_focus();
        }
    }
}

/// Hide the button for the rest of this run ("Hide this button").
///
/// In memory only, deliberately: the flag dies with the process, so reopening
/// the app always brings the control back. There is no way to lock yourself out
/// of the only control that can change hosts.
fn hide(app: &tauri::AppHandle) {
    if let Ok(mut slot) = app.state::<AppState>().wipe_overlay_hidden.lock() {
        *slot = true;
    }
    if let Ok(mut panel) = app.state::<AppState>().wipe_panel_open.lock() {
        *panel = false;
    }
    if let Some(overlay) = app.get_webview_window(LABEL) {
        let _ = overlay.hide();
    }
    if let Some(anchor) = anchor(app) {
        let _ = anchor.set_focus();
    }
}

/// Erase everything, the button's whole purpose.
///
/// Two halves, because neither is sufficient alone:
///
/// 1. **The page's half** ([`WIPE_REQUESTED_EVENT`] to the main window): a live
///    page signs out server-side while it still has the token and drops what JS
///    can reach. A page that is not running simply never answers — expected,
///    and exactly the case the native button exists for.
/// 2. **The shell's half**, which needs no page at all:
///    `clear_all_browsing_data` erases the WebView's own storage through the
///    platform (HttpOnly cookies, every origin's localStorage, IndexedDB,
///    caches), then the saved address and pinned certificate are dropped and
///    the address screen comes back.
///
/// The page gets a head start so its logout call can leave the device before
/// the cookie store is cleared underneath it; after that the wipe does not
/// depend on the page having answered.
fn wipe_everything(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.emit(WIPE_REQUESTED_EVENT, ());
    }
    let for_finish = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(PAGE_WIPE_GRACE_MS));
        if let Some(main) = for_finish.get_webview_window(MAIN_LABEL) {
            if let Err(e) = main.clear_all_browsing_data() {
                eprintln!(
                    "wipe: could not clear the WebView's own storage ({e}); the saved \
                     connection is still dropped below"
                );
            }
        }
        forget_connection(&for_finish);
        set_panel(&for_finish, false);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The anchor rule: the button sits inset from the bottom-left corner of the
    /// window the user is looking at, with the inset scaled to that window's DPI
    /// — and the panel keeps the same bottom edge while it is open, so opening it
    /// never moves the control under the pointer.
    #[test]
    fn the_overlay_anchors_to_the_bottom_left_of_the_window_it_floats_over() {
        // 1200x780 window at (100, 50), 46x46 button, 100% DPI.
        assert_eq!(position((100, 50), (1200, 780), (46, 46), 1.0), (114, 770));
        // 200% DPI: positions and sizes are already physical pixels, so only the
        // margin scales.
        assert_eq!(position((100, 50), (1200, 780), (92, 92), 2.0), (128, 710));
        // Expanded panel, anchored the same way: its bottom edge is the window's.
        assert_eq!(position((0, 0), (800, 600), (400, 280), 1.0), (14, 306));
        // The panel is a real expansion of the button, not a different control.
        assert!(PANEL_SIZE.0 > BUTTON_SIZE.0 && PANEL_SIZE.1 > BUTTON_SIZE.1);
    }
}
