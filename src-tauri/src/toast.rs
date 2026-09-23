//! Desktop toast with an OS-enforced lifetime — audit fix **F3**
//! (`FEATURE_PLAN.md` §1).
//!
//! `tauri-plugin-notification` registers only `notify` on desktop: there is no
//! close or cancel command at all, and its `window.Notification` shim returns a
//! plain object with no `close()`. Every toast it posted therefore sat in the
//! Windows Action Center database until the user cleared it by hand — durable,
//! OS-held copies of notification text. That is the same *retention* class the
//! FBI recovered decrypted Signal previews from on iOS: the encryption was
//! never broken; the OS had been handed the plaintext and kept it.
//!
//! This module shows the same toast through WinRT directly, with two changes:
//!
//! * **A fixed tag + group** (`e2e-chat`) — a new toast with the same tag
//!   *replaces* the previous one in Action Center instead of queueing behind
//!   it, so the store can never grow beyond one entry.
//! * **An `ExpirationTime`** of `ttl` seconds — Windows itself removes the
//!   toast from Action Center when it expires, with no client-side bookkeeping
//!   (and no race between "cancel the old one" and "show the new one").
//!
//! The AUMID mirrors `tauri-plugin-notification`'s desktop path exactly — the
//! app's identifier when installed, PowerShell's registered AUMID when run
//! unpackaged from `target/{debug,release}` — so dev and installed builds toast
//! identically to what the plugin would have posted.
//!
//! Reached from the page as an **event** (`box:notify`, registered in
//! `lib.rs`) rather than a command, because Tauri refuses app commands to
//! remote origins — the same reason `box:change-server` is an event.

/// Show a desktop toast that expires `ttl` seconds after it appears.
#[cfg(windows)]
pub fn show(app: &tauri::AppHandle, title: &str, body: &str, ttl_secs: u64) -> Result<(), String> {
    use windows::core::{HSTRING, Interface};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::DateTime;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let xml = format!(
        "<toast><visual><binding template=\"ToastGeneric\">\
         <text>{title}</text><text>{body}</text>\
         </binding></visual></toast>",
        title = xml_escape(title),
        body = xml_escape(body),
    );
    let doc = XmlDocument::new().map_err(|e| e.to_string())?;
    doc.LoadXml(&HSTRING::from(&xml)).map_err(|e| e.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&doc).map_err(|e| e.to_string())?;

    // Fixed tag + group: the next toast REPLACES this one in Action Center
    // rather than queueing — the store holds at most one entry.
    toast.SetTag(&HSTRING::from("e2e-chat")).map_err(|e| e.to_string())?;
    toast.SetGroup(&HSTRING::from("e2e-chat")).map_err(|e| e.to_string())?;

    // ExpirationTime: WinRT DateTime is 100ns ticks since 1601-01-01 UTC
    // (Windows FILETIME). Clamped so a bad payload can't park a toast forever.
    let ttl = ttl_secs.clamp(1, 3600) as i64;
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let expires = 11_644_473_600i64 + now_unix + ttl;
    // WinRT takes `IReference<DateTime>` — a boxed nullable — which windows-rs
    // cannot build from a bare struct; PropertyValue is the canonical box.
    let expiry = DateTime {
        UniversalTime: expires * 10_000_000,
    };
    let boxed = windows::Foundation::PropertyValue::CreateDateTime(expiry)
        .map_err(|e| e.to_string())?
        .cast::<windows::Foundation::IReference<DateTime>>()
        .map_err(|e| e.to_string())?;
    toast.SetExpirationTime(&boxed).map_err(|e| e.to_string())?;

    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id(app)))
        .map_err(|e| e.to_string())?;
    notifier.Show(&toast).map_err(|e| e.to_string())
}

/// The AUMID — copied from tauri-plugin-notification's desktop path so the
/// toast is attributed exactly as the plugin's would have been.
#[cfg(windows)]
fn app_id(app: &tauri::AppHandle) -> String {
    // PowerShell's AUMID: registered on every Windows install. Used when
    // running unpackaged from target/, where `com.e2echat.app` has no Start
    // Menu shortcut to activate (WinRT refuses an unregistered id outright).
    // Same fallback notify-rust applies (`Toast::POWERSHELL_APP_ID`).
    const POWERSHELL_APP_ID: &str =
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

    let sep = std::path::MAIN_SEPARATOR;
    let unpackaged = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.display().to_string()))
        .map(|dir| {
            dir.ends_with(&format!("{sep}target{sep}debug"))
                || dir.ends_with(&format!("{sep}target{sep}release"))
        })
        .unwrap_or(false);

    if unpackaged {
        POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.to_string()
    }
}

#[cfg(windows)]
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // WinRT toast XML is 16-bit; drop characters it cannot carry.
            c if c as u32 <= 0x1F && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// macOS / Linux: the same plugin path the shim used — no worse than the
/// status quo (neither platform had close-through-the-plugin either), and the
/// Windows Action Center retention is the case F3 was filed for. The tag/
/// expiration guarantees are Windows-specific.
#[cfg(not(windows))]
pub fn show(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    _ttl_secs: u64,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title.to_string())
        .body(body.to_string())
        .show()
        .map_err(|e| e.to_string())
}
