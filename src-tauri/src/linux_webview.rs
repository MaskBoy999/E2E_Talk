//! WebKitGTK platform hooks (Linux only).
//!
//! One thing WebKitGTK will not do on its own, and it is the Linux half of the
//! wall `win_webview.rs` tears down on Windows: **the server's certificate is
//! self-signed**, WebKit verifies it against the system trust store (which knows
//! nothing about the user's private CA), and the main window is a *remote* page.
//! So the window loads and the WebView replaces the app with its own TLS error
//! page — reported from an Arch install as *"unacceptable TLS certificate"*.
//!
//! wry has no API for this: `WebView`/`WebViewBuilder` expose nothing that
//! reaches `load-failed-with-tls-errors`, and `tauri.conf.json`'s `dangerous*`
//! knobs are WebView2-only. What Tauri *does* give is the raw
//! `webkit2gtk::WebView` (`PlatformWebview::inner()`), which is enough to attach
//! the signal ourselves:
//!
//! 1. WebKit raises `load-failed-with-tls-errors` with the failing URI and the
//!    certificate it refused;
//! 2. we compare that certificate's SHA-256 against the fingerprint the user
//!    already trusted (`cert_probe.rs`, the app's TOFU pin);
//! 3. **only on a match** do we tell WebKit's context to allow the certificate
//!    for that host and reload the URI.
//!
//! That step 3 is deliberately not `webkit_web_context_set_tls_errors_policy`
//! (the blanket "ignore every TLS error" switch): a changed certificate still
//! fails, exactly as `check_pinned_cert` refuses to open the window at all when
//! the live fingerprint no longer matches the pin. The hook is the WebView
//! catching up with a decision Rust already made, not a downgrade.
//!
//! The pin is read **live** from `AppState` on every failure rather than captured
//! at install time, because one window outlives a *Change Server Address*: the
//! hook is installed once, at window creation, while the pin it must honour is
//! replaced every time the address changes.
//!
//! Compiled on every platform (the body is `cfg`-gated, `install` is a no-op
//! elsewhere) so that `host_of` keeps its unit tests on the machines the project
//! is actually developed on — which is why the helpers below are allowed to look
//! unused off Linux.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use tauri::WebviewWindow;

/// Host (with its port when it is not the scheme's default) as WebKit wants it
/// for `allow_tls_certificate_for_host`.
///
/// WebKit matches the allowance **per host string**, and it includes the port
/// whenever the URI has an explicit non-default one. The app's server almost
/// always does (`https://100.x.x.x:3443`), so passing the bare hostname would
/// silently allow nothing and the reload would fail again with the same error.
pub fn host_of(uri: &str) -> Option<String> {
    let url = url::Url::parse(uri).ok()?;
    let host = url.host_str()?.to_string();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// Whether the certificate WebKit refused is the one the user pinned.
///
/// Fails closed: no pin, no certificate, or a different fingerprint are all
/// "no". A mismatch here is the same condition that stops the app window from
/// being opened at all (`check_pinned_cert`), so refusing only ever means "show
/// the error page", never "silently trust something else".
pub fn cert_allowed(pinned: Option<&str>, der: Option<&[u8]>) -> bool {
    match (pinned, der) {
        (Some(pinned), Some(der)) => cert_probe_sha256(der).eq_ignore_ascii_case(pinned),
        _ => false,
    }
}

/// SHA-256 of a leaf certificate, lowercase hex — the same encoding
/// `cert_probe::fingerprint_of` pins, so the two are directly comparable.
fn cert_probe_sha256(der: &[u8]) -> String {
    crate::cert_probe::sha256_hex(der)
}

/// Install the certificate hook on the app window.
///
/// **Must run before the window is pointed at the server**, for the same reason
/// as the WebView2 hooks: the window is created on `about:blank`, this is
/// attached, and only then does it navigate.
pub fn install(window: &WebviewWindow, app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        // webkit2gtk 2.x exports the `*Ext` traits at the crate root (there is no
        // `prelude` module); `TlsCertificateExt` comes from gio.
        use webkit2gtk::gio::prelude::TlsCertificateExt;
        use webkit2gtk::{WebContextExt, WebViewExt};

        let pinned_app = app.clone();
        let attached = window.with_webview(move |platform| {
            let view = platform.inner();
            view.connect_load_failed_with_tls_errors(
                move |view, failing_uri, certificate, errors| {
                    let pinned = crate::pinned_cert(&pinned_app);
                    let der = certificate.certificate();
                    if !cert_allowed(pinned.as_deref(), der.as_deref()) {
                        eprintln!(
                            "linux webview: refused {failing_uri} — the certificate WebKit \
                             rejected does not match the pinned fingerprint ({errors:?}); \
                             re-run setup to trust the current certificate"
                        );
                        return false;
                    }
                    let Some(host) = host_of(failing_uri) else {
                        eprintln!("linux webview: {failing_uri} has no host to allow");
                        return false;
                    };
                    let Some(context) = view.context() else {
                        eprintln!("linux webview: the view has no WebContext");
                        return false;
                    };
                    // The pin matched, so this is the certificate Rust already
                    // decided to trust — remember the exception for that host and
                    // re-issue the load. WebKit then serves the app normally for
                    // the rest of the session, subresources and WebSockets
                    // included (the allowance is per host, on the context).
                    context.allow_tls_certificate_for_host(certificate, &host);
                    eprintln!(
                        "linux webview: accepting the pinned certificate for {host} after a \
                         TLS refusal from WebKit"
                    );
                    view.load_uri(failing_uri);
                    true
                },
            );
        });
        if let Err(e) = attached {
            eprintln!("linux webview: could not attach the certificate hook: {e}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The port is part of the host key WebKit matches on. Dropping it would make
    /// every allowance a silent no-op on the app's usual `https://ip:3443`.
    #[test]
    fn the_host_carries_its_non_default_port() {
        assert_eq!(
            host_of("https://100.1.2.3:3443/login.html").as_deref(),
            Some("100.1.2.3:3443")
        );
        assert_eq!(
            host_of("https://chat.example.ts.net/").as_deref(),
            Some("chat.example.ts.net")
        );
        // A default port is normalised away by the URL parser, which is what
        // WebKit expects too (`example.com`, not `example.com:443`).
        assert_eq!(
            host_of("https://chat.example.ts.net:443/app").as_deref(),
            Some("chat.example.ts.net")
        );
        assert_eq!(host_of("not a uri"), None);
        // A scheme with no authority at all — nothing to allow a certificate for.
        assert_eq!(host_of("about:blank"), None);
        assert_eq!(host_of("data:text/plain,hi"), None);
    }

    /// The rule the whole hook rests on: only the pinned certificate is
    /// accepted, and anything unverifiable is refused rather than allowed.
    #[test]
    fn only_the_pinned_certificate_is_allowed() {
        let der = b"leaf certificate DER";
        let pinned = crate::cert_probe::sha256_hex(der);
        assert!(cert_allowed(Some(&pinned), Some(der)));
        // Case-insensitive: the pin is stored by the probe, but a hand-edited
        // config must not turn a match into a refusal.
        assert!(cert_allowed(Some(&pinned.to_uppercase()), Some(der)));
        assert!(!cert_allowed(Some("aa11"), Some(der)));
        assert!(!cert_allowed(Some(&pinned), Some(b"a different certificate")));
        // No pin yet, or no certificate in the signal: nothing to verify.
        assert!(!cert_allowed(None, Some(der)));
        assert!(!cert_allowed(Some(&pinned), None));
    }
}
