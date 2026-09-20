//! WebView2 platform hooks (Windows only).
//!
//! Two things WebView2 will not do on its own, and both made the box look broken
//! on an ordinary install:
//!
//! 1. **The server's certificate is self-signed**, and wry never handles
//!    `ServerCertificateErrorDetected`. Every launch therefore showed Chromium's
//!    *"Your connection isn't private"* page in the app window, and the app only
//!    worked if the user clicked through it. Confirmed by reading the live DOM of
//!    a running box (`chrome-error://chromewebdata/`, title *Privacy error*,
//!    `NET::ERR_CERT_AUTHORITY_INVALID`) — the same wall the Android build hit,
//!    where the default *cancels* the load instead of showing a page.
//!
//!    The app has already pinned the certificate's SHA-256 fingerprint
//!    (`cert_probe.rs`), and `check_pinned_cert` refuses to open this window at
//!    all when the host presents a different one. Honouring that pin here is the
//!    WebView catching up with a decision Rust already made — it is deliberately
//!    **not** a blanket "ignore certificate errors".
//!
//!    The hook is therefore installed **unconditionally**, and that is the whole
//!    point: an earlier revision only installed it when a pin already existed,
//!    reasoning that with nothing pinned there was nothing to compare. That left
//!    the warning reachable through the one path that matters — a launch where
//!    the pin could not be established (host briefly unreachable, so
//!    `fingerprint_blocking` failed and `ensure_pin_blocking` gave up), which is
//!    exactly the "it still says *Your connection isn't private*" report. There
//!    is no such launch any more: every caller that opens this window has a pin
//!    in hand first (`open_main`, `save_config`), so by the time a certificate
//!    error can be raised the decision has already been made, and a pin that
//!    cannot be established now routes to the setup screen instead of to a
//!    browser warning page.
//!
//! 2. **Permissions prompt.** Wry only treats `CLIPBOARD_READ` as implicitly
//!    allowed; camera, microphone and notifications fall through to WebView2's
//!    own prompt. So every call asked the user to allow the microphone, for their
//!    own server, at their own address — and this is a calling app, so the answer
//!    is always yes. Only the kinds the app actually uses are granted; everything
//!    else (geolocation, MIDI, sensors…) keeps WebView2's default.

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_14, COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
    COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
};
use webview2_com::{PermissionRequestedEventHandler, ServerCertificateErrorDetectedEventHandler};
use windows_core::Interface;

/// The permission kinds the app genuinely needs, and therefore grants without a
/// prompt. Everything else is left to WebView2.
///
/// * `CAMERA` / `MICROPHONE` — voice, video and screen-share calls.
/// * `NOTIFICATIONS` — the native-notification path (the box exists so message
///   notifications reach the OS; without a grant the plugin shim reads
///   `permission === "denied"` and `showBrowserNotification()` drops every one).
/// * `AUTOPLAY` — a soundboard clip or an incoming call must not need a click
///   before it makes sound.
/// * `CLIPBOARD_READ` — wry already allows this one; it is listed here so the
///   whole policy is visible in a single place.
const GRANTED_PERMISSIONS: &[COREWEBVIEW2_PERMISSION_KIND] = &[
    COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
    COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
    COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
];

/// Install the hooks on the app window.
///
/// **Must run before the window is pointed at the server.** WebView2 raises these
/// events per navigation, so a window created straight on the remote URL would
/// race its own first load — which is why `open_main_window` builds it on
/// `about:blank`, installs these, and only then navigates.
pub fn install(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(move |platform| {
        // The controller is only valid on the thread that created it; Tauri hands
        // this closure to that thread, so the raw call is safe here.
        let core = match unsafe { platform.controller().CoreWebView2() } {
            Ok(core) => core,
            Err(e) => {
                eprintln!("webview2 hooks: the controller has no CoreWebView2: {e}");
                return;
            }
        };

        // ── Permissions ───────────────────────────────────────────────────
        let permissions = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            unsafe { args.PermissionKind(&mut kind)? };
            if GRANTED_PERMISSIONS.contains(&kind) {
                unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = unsafe { core.add_PermissionRequested(&permissions, &mut token) } {
            eprintln!("webview2 hooks: could not hook PermissionRequested: {e}");
        }

        // ── The pinned certificate ────────────────────────────────────────
        // `ServerCertificateErrorDetected` arrived with WebView2 runtime 1.0.1466
        // (interface `_14`). Runtimes older than that are long out of support, but
        // asking through the cast is still the honest way to find out — no
        // interface means no hook, and the user gets told why.
        let core14 = match core.cast::<ICoreWebView2_14>() {
            Ok(core14) => core14,
            Err(e) => {
                eprintln!(
                    "webview2 hooks: this WebView2 runtime has no \
                     ServerCertificateErrorDetected ({e}); the certificate warning page will \
                     still be shown — update the WebView2 Runtime, or give the host a \
                     certificate Windows already trusts"
                );
                return;
            }
        };
        let certificates =
            ServerCertificateErrorDetectedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                // There is nothing left to compare here: `open_main` already
                // checked the live certificate against the pin before this window
                // was given a URL, and `nav_allowlist` keeps it on that one origin
                // afterwards. A mismatch is refused before a certificate error can
                // ever be raised.
                unsafe {
                    args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW)?
                };
                Ok(())
            }));
        let mut cert_token = 0i64;
        if let Err(e) =
            unsafe { core14.add_ServerCertificateErrorDetected(&certificates, &mut cert_token) }
        {
            eprintln!("webview2 hooks: could not hook ServerCertificateErrorDetected: {e}");
        }
    });
}
