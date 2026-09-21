fn main() {
    // ── Re-run this build script when the app icons change ──────────────────
    //
    // WHY THIS IS NOT REDUNDANT
    //
    // On Windows `tauri-build` embeds the application icon into the executable
    // through `tauri-winres` → `embed-resource`, which writes the icon it is
    // given into `target/<profile>/resources/icon.ico` and links the generated
    // `.rc` into the binary. That embedded icon is what Explorer shows for the
    // desktop/Start-menu shortcut and the taskbar.
    //
    // `tauri-build` emits `cargo:rerun-if-changed` for `tauri.conf.json` (and
    // for any declared `bundle.resources`), but **never for the icons**. Cargo's
    // "re-run when any file in the package changes" fallback only applies while
    // a build script emits *no* rerun instructions at all — and tauri-build does
    // emit one — so once `tauri.conf.json` had been seen, a changed
    // `icons/icon.ico` no longer re-ran the script. The Windows resource, and
    // therefore the icon baked into the `.exe` (and the installed shortcut),
    // stayed on the *previous* artwork.
    //
    // The symptom: after switching the artwork, the Android launcher and the
    // in-app icon showed the new drawing while the installed desktop app and its
    // shortcut kept showing the old one. This is exactly the failure the plan's
    // "one icon for every platform" work (§13.11) was meant to prevent, one
    // layer below where it was looking.
    //
    // Declaring the icons here makes Cargo re-run the script on any icon change,
    // which re-embeds the resource from `icons/icon.ico`. Keep this list in sync
    // with the outputs of `npm run icon` (tools/box-icon.mjs).
    for icon in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/32x32.png",
        "icons/64x64.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    tauri_build::build()
}
