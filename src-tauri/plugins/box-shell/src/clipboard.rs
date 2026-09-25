//! Putting a decrypted attachment on the **OS** clipboard (desktop).
//!
//! The page cannot do this itself. WebView2 — like every other Chromium — takes
//! exactly three types through the async Clipboard API (`text/plain`,
//! `text/html`, `image/png`), so `navigator.clipboard.write()` with a real file
//! type (`.exe`, `.zip`, `.pdf` …) is refused *by the engine*, and the only
//! honest thing the page could say was "this browser only allows images".
//!
//! There is no web API that puts a **file** on the clipboard, because each
//! platform's file format is a *path*:
//!
//! | platform    | clipboard format        | payload                            |
//! |-------------|-------------------------|------------------------------------|
//! | Windows     | `CF_HDROP`              | `DROPFILES` header + UTF-16 paths   |
//! | X11/Wayland | `text/uri-list`         | `file:///…` lines, CRLF-terminated  |
//! | macOS       | file URL (pasteboard)   | `file:///…`, set via `osascript`    |
//!
//! Every one of those points at a file that must still exist when the user
//! pastes, so a copy has to materialise the decrypted bytes first. That is the
//! whole cost of the feature, and it is contained deliberately:
//!
//! * the file is written into **the app's own cache dir** (`<app cache>/clipboard/`),
//!   never a shared temp folder, so it is not visible in another app's editable
//!   list and it goes away with the app's data;
//! * **one entry at a time**: each copy deletes the previous file, so a
//!   clipboard entry that has been replaced cannot leave plaintext behind, and
//!   startup empties the folder — a copy cannot outlive the launch that made it;
//! * the name is **sanitised** (no separators, no traversal, bounded length):
//!   it arrives from a server-supplied attachment name, which is untrusted;
//! * nothing is spawned unless the platform needs it (`osascript` on macOS,
//!   `wl-copy`/`xclip` on Linux), and the bytes never leave the page otherwise —
//!   the page is the only place the plaintext exists.
//!
//! This is **not** a way to read the host's clipboard; there is no read path in
//! this module at all. Writing a file the user asked to copy is the only
//! capability the page gains.

use std::path::PathBuf;
use tauri::{Manager, Runtime};

/// Subdirectory of the app cache dir that holds the one copied file.
const TEMP_SUBDIR: &str = "clipboard";

/// Longest filename kept (UTF-8 bytes). Long enough for real names, short
/// enough that the joined path cannot approach a platform path limit.
const MAX_NAME_LEN: usize = 120;

/// The directory a copied file lives in, created if it is missing.
pub fn temp_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("clipboard: no app cache dir: {e}"))?;
    let dir = base.join(TEMP_SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("clipboard: {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Delete everything an earlier copy left behind.
///
/// Best effort by design: this is called at startup and before every write, and
/// neither is a place where failing to remove a stale *cache* entry should stop
/// the user from copying something.
pub fn clear<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Ok(dir) = temp_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// A filesystem-safe rendering of an attachment name.
///
/// The name comes from a message the server stores, so it is untrusted input:
/// a name of `../../.bashrc` (or one containing a NUL or a Windows drive
/// separator) must not be able to choose *where* the copy lands. Everything
/// that is not a plain path component is replaced with `_`, so the result is a
/// single component with a recognisable name; an empty result falls back to
/// `attachment`, and the extension is kept because it is what tells the
/// receiving app what the file is.
pub fn safe_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len().min(MAX_NAME_LEN));
    for ch in name.chars() {
        let keep =
            !ch.is_control() && !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        out.push(if keep { ch } else { '_' });
        if out.len() >= MAX_NAME_LEN {
            break;
        }
    }
    // Separators are gone above, so the name is already a single component; the
    // dot runs are cosmetic, and removing them keeps the result from *looking*
    // like a path (`..exe`, `.hidden`) in the folder the user is pasting into.
    let trimmed = out
        .trim_matches(|c: char| c == '.' || c == ' ')
        .replace("..", "__");
    if trimmed.is_empty() {
        return "attachment".to_string();
    }
    trimmed
}

/// Write `bytes` into the clipboard folder and put that path on the clipboard.
///
/// Returns the path that was written, which is what a pasting app receives.
pub fn copy_file<R: Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let dir = temp_dir(app)?;
    // One entry at a time: the clipboard holds a *path*, so replacing the entry
    // is what makes the previous copy dead. Leaving the old file would keep a
    // decrypted attachment in the cache dir for no reader at all.
    clear(app);
    let path = dir.join(safe_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("clipboard: writing {}: {e}", path.display()))?;
    if let Err(e) = set_clipboard_file(&path) {
        // Do not leave a file nothing points at.
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    Ok(path)
}

// ── Windows: CF_HDROP ────────────────────────────────────────────────────

/// A file list on the Windows clipboard.
///
/// `CF_HDROP` is a `DROPFILES` header followed by a **double-null-terminated**
/// list of paths, UTF-16 when `fWide` is set. Paths are widened rather than
/// byte-cast because the ANSI form would mangle any non-ASCII character — an
/// attachment name is arbitrary text from a message.
#[cfg(windows)]
fn set_clipboard_file(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, POINT};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0); // end of this path
    wide.push(0); // end of the list
    let header = std::mem::size_of::<DROPFILES>();
    let total = header + wide.len() * 2;

    unsafe {
        let hglobal: HGLOBAL =
            GlobalAlloc(GMEM_MOVEABLE, total).map_err(|e| format!("clipboard: GlobalAlloc: {e}"))?;
        let dst = GlobalLock(hglobal) as *mut u8;
        if dst.is_null() {
            let _ = GlobalFree(Some(hglobal));
            return Err("clipboard: GlobalLock returned null".to_string());
        }
        let drop = DROPFILES {
            pFiles: header as u32,
            pt: POINT { x: 0, y: 0 },
            // `fWide` is what makes the list below UTF-16; the ANSI form would
            // mangle any non-ASCII character in a name.
            fNC: false.into(),
            fWide: true.into(),
        };
        std::ptr::copy_nonoverlapping(&drop as *const DROPFILES as *const u8, dst, header);
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, dst.add(header), wide.len() * 2);
        // The handle is unlocked before it is handed over; the clipboard owns it
        // from then on, so it is only freed when the handover did not happen.
        let _ = GlobalUnlock(hglobal);

        let outcome = (|| -> Result<(), String> {
            OpenClipboard(None).map_err(|e| format!("clipboard: another app holds it ({e})"))?;
            let written = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| format!("clipboard: EmptyClipboard: {e}"))?;
                SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hglobal.0)))
                    .map_err(|e| format!("clipboard: SetClipboardData: {e}"))?;
                Ok(())
            })();
            // Closing is not optional: an open clipboard blocks every other app's
            // clipboard use until this process dies.
            let _ = CloseClipboard();
            written
        })();

        if outcome.is_err() {
            let _ = GlobalFree(Some(hglobal));
        }
        outcome
    }
}

// ── macOS: the file pasteboard, via osascript ────────────────────────────

/// Hand the file to LaunchServices' own pasteboard.
///
/// `osascript` is used rather than linking AppKit because this crate has no
/// Objective-C surface, and `POSIX file` is the coercion that makes AppleScript
/// put a *file URL* on the clipboard (a bare path string would paste as text).
/// It runs unelevated, inherits no extra rights, and is given one literal
/// string argument: a path this process just wrote.
#[cfg(target_os = "macos")]
fn set_clipboard_file(path: &std::path::Path) -> Result<(), String> {
    let escaped = path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("set the clipboard to (POSIX file \"{escaped}\")");
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("clipboard: osascript: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "clipboard: osascript: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

// ── Linux: text/uri-list, via wl-copy or xclip ───────────────────────────

/// A `file:///…` URI for a local path.
///
/// Only characters outside the unreserved set are escaped, which is what makes
/// a path with a space in it arrive as one entry instead of two.
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn file_uri(path: &std::path::Path) -> String {
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                uri.push(byte as char)
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

/// Is `tool` an executable on `PATH`? (No crate is pulled in for this.)
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn on_path(tool: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(tool);
        candidate.is_file()
            && std::fs::metadata(&candidate)
                .map(|m| {
                    use std::os::unix::fs::PermissionsExt;
                    m.permissions().mode() & 0o111 != 0
                })
                .unwrap_or(false)
    })
}

/// X11/Wayland: a URI list is the closest thing either has to a file list.
///
/// `wl-copy` (Wayland) is preferred, then `xclip` (X11). Neither is part of a
/// base install, so a machine with neither gets an error that says what to do
/// rather than a silent no-op. Note that both tools keep a process alive to
/// serve the selection — that is how X11 selections work, and it is their
/// process, not ours.
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn set_clipboard_file(path: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let payload = format!("{}\r\n", file_uri(path));
    let (tool, args): (&str, &[&str]) = if on_path("wl-copy") {
        ("wl-copy", &["--type", "text/uri-list"])
    } else if on_path("xclip") {
        ("xclip", &["-selection", "clipboard", "-t", "text/uri-list", "-i"])
    } else {
        return Err(
            "clipboard: neither wl-copy nor xclip is installed, so a file cannot reach the \
             clipboard on this system — use Save a copy instead"
                .to_string(),
        );
    };

    let mut child = Command::new(tool)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("clipboard: {tool}: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| format!("clipboard: {tool}: {e}"))?;
    }
    drop(child.stdin.take());
    let out = child
        .wait_with_output()
        .map_err(|e| format!("clipboard: {tool}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("clipboard: {tool}: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// The clipboard itself, on the only platform this repo builds and runs here.
///
/// `set_clipboard_file` and the reader below are *different* code paths
/// (`GlobalAlloc`/`SetClipboardData` versus `GetClipboardData`/`DragQueryFileW`),
/// so a pass means the OS accepted the file list and hands the same file back —
/// the property a paste actually depends on. It touches the machine's real
/// clipboard, which is unavoidable for a test of the real clipboard.
#[cfg(all(test, windows))]
mod windows_clipboard {
    use super::set_clipboard_file;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// The first path on the clipboard, read back through the same public
    /// format Explorer pastes from.
    fn clipboard_first_path() -> String {
        unsafe {
            OpenClipboard(None).expect("clipboard is free");
            let list = GetClipboardData(CF_HDROP.0 as u32).expect("CF_HDROP is on the clipboard");
            let hdrop = HDROP(list.0);
            let needed = DragQueryFileW(hdrop, 0, None) as usize;
            let mut buf = vec![0u16; needed + 1];
            let written = DragQueryFileW(hdrop, 0, Some(&mut buf)) as usize;
            let _ = CloseClipboard();
            assert!(written > 0, "the file list is empty");
            String::from_utf16_lossy(&buf[..written])
        }
    }

    #[test]
    fn a_copied_file_survives_the_round_trip() {
        let dir = std::env::temp_dir().join("e2e-clipboard-round-trip");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Equilotl.exe");
        std::fs::write(&file, b"MZ pretend installer").unwrap();

        set_clipboard_file(&file).expect("the file reaches the clipboard");

        // A clipboard entry is a *path*: the paste only works while the file is
        // still there, which is why `copy_file` keeps exactly one.
        assert!(file.exists(), "the file the clipboard points at must still exist");
        assert_eq!(
            clipboard_first_path().to_lowercase(),
            file.to_string_lossy().to_lowercase(),
        );
        let _ = std::fs::remove_file(&file);
    }
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    /// The property that matters: whatever the name, the result is **one** path
    /// component, so joining it to the clipboard folder cannot land anywhere
    /// else. Checked against the shapes an attacker would actually try.
    #[test]
    fn names_cannot_escape_the_clipboard_folder() {
        for hostile in [
            "../../.ssh/authorized_keys",
            "..\\..\\Windows\\evil.exe",
            "C:\\Users\\me\\secret.txt",
            "/etc/passwd",
            ".",
            "..",
            "/",
            "\\",
            "",
            "a\nb\u{0}c.txt",
        ] {
            let safe = safe_name(hostile);
            assert!(!safe.is_empty(), "{hostile:?} produced an empty name");
            assert!(!safe.contains('/') && !safe.contains('\\'), "{hostile:?} kept a separator");
            assert!(!safe.contains(':'), "{hostile:?} kept a drive separator");
            assert!(safe != "." && safe != "..", "{hostile:?} stayed a traversal");
            assert!(
                !safe.chars().any(|c| c.is_control()),
                "{hostile:?} kept a control character"
            );
            // Joining it must not move the result out of its own folder.
            let joined = std::path::Path::new("/cache/clipboard").join(&safe);
            assert_eq!(
                joined.parent(),
                Some(std::path::Path::new("/cache/clipboard")),
                "{hostile:?} escaped the clipboard folder"
            );
        }
    }

    #[test]
    fn ordinary_names_survive_unchanged() {
        assert_eq!(safe_name("Equilotl.exe"), "Equilotl.exe");
        assert_eq!(safe_name("Q3 report — final.pdf"), "Q3 report — final.pdf");
        assert_eq!(safe_name("photo (1).png"), "photo (1).png");
        // Empty or dot-only names still produce something usable.
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_name("..."), "attachment");
        // Bounded, so the joined path stays well inside every platform limit.
        assert!(safe_name(&"x".repeat(5000)).len() <= 120);
    }
}
