//! Saving a decrypted file to **disk** (desktop).
//!
//! The page cannot do this itself inside the shell. An `<a download>` on a
//! blob: URL is what every browser download in the app relies on, and the
//! WebViews refuse it: WebView2 on Windows and the Android WebView both drop the
//! navigation silently, so "Download", "Save a copy", an exported theme or a
//! backup reported success (the click happened, no error was raised) and no
//! file ever appeared. In a plain browser the same code works, which is exactly
//! the split the report names.
//!
//! Android gets the Kotlin half of the same command (MediaStore, into the
//! public Downloads collection). Here the bytes are written into the user's
//! Downloads directory straight from Rust, with a fallback to the Desktop and
//! then the app cache so a machine with an unusual profile still gets the file
//! somewhere it was told about.
//!
//! The name arrives from server-supplied content (an attachment name, an
//! export), so it is untrusted: [`crate::clipboard::safe_name`] is reused so a
//! name can never choose *where* the file lands, and an existing file is never
//! overwritten — the name gets a ` (n)` suffix instead.

use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime};

/// Write `bytes` under `name` into the best directory this machine offers.
///
/// Returns the absolute path written, which the page shows in a toast ("Saved
/// to …") — the reassurance that the file actually landed somewhere, since no
/// dialog was involved.
pub fn save_file<R: Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let dir = save_dir(app)?;
    let path = unique_path(&dir, &crate::clipboard::safe_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("saveFile: writing {}: {e}", path.display()))?;
    Ok(path)
}

/// Downloads first (where a user looks for a saved file), then Desktop, then
/// the app cache as a last resort so the command never fails for want of a
/// directory. Every candidate is created if missing.
fn save_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let resolver = app.path();
    let candidates = [
        resolver.download_dir().ok(),
        resolver.desktop_dir().ok(),
        resolver.app_cache_dir().ok(),
    ];
    for candidate in candidates.into_iter().flatten() {
        if std::fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err("saveFile: no writable Downloads, Desktop or cache directory".to_string())
}

/// `name`, or `stem (n).ext` for the first `n` whose file does not exist yet.
///
/// Saving the same attachment twice must add a second file rather than replace
/// the first: a save is often the second half of "keep a copy", and a dialog
/// never asked whether to overwrite.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..10_000 {
        let file = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(file);
        if !candidate.exists() {
            return candidate;
        }
    }
    // Ten thousand collisions is not a real case; fall back to the plain name
    // rather than looping forever.
    first
}

#[cfg(test)]
mod tests {
    use super::unique_path;

    #[test]
    fn collisions_get_a_suffix_instead_of_overwriting() {
        let dir = std::env::temp_dir().join("e2e-save-unique");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // First save takes the name as-is.
        let first = unique_path(&dir, "report.pdf");
        assert_eq!(first.file_name().unwrap(), "report.pdf");
        std::fs::write(&first, b"one").unwrap();

        // A second save of the same name must not overwrite.
        let second = unique_path(&dir, "report.pdf");
        assert_eq!(second.file_name().unwrap(), "report (1).pdf");
        std::fs::write(&second, b"two").unwrap();

        let third = unique_path(&dir, "report.pdf");
        assert_eq!(third.file_name().unwrap(), "report (2).pdf");

        // Names without an extension keep the whole stem.
        std::fs::write(dir.join("notes"), b"x").unwrap();
        assert_eq!(
            unique_path(&dir, "notes").file_name().unwrap(),
            "notes (1)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
