; =====================================================================
; installer-hooks.nsh — Windows NSIS installer hooks
; =====================================================================
;
; WHY THIS FILE EXISTS
;
; The desktop shortcut can keep showing the *previous* artwork after an
; upgrade, even though the new icon is embedded in the .exe correctly. The
; icon does not come from the .exe at the moment Explorer paints it — it
; comes from Explorer's icon cache, which is keyed by path and only
; invalidated when something tells the shell to look again. A Tauri upgrade
; replaces the .exe at the same path, so the cached entry is still valid as
; far as Explorer is concerned and the old drawing survives indefinitely.
;
; `src-tauri/build.rs` already makes sure a *changed* icon gets re-embedded
; (tauri-build never declared the icon files as rerun inputs). That fixes
; what is in the .exe; this fixes what Explorer actually displays.
;
; HOW IT IS REFRESHED
;
; Two mechanisms, because neither is sufficient alone:
;
;   * `SHChangeNotify(SHCNE_ASSOCCHANGED)` tells the running shell that
;     associations/icons changed, which invalidates its in-memory caches
;     immediately. This is instant and needs no process launch.
;   * `ie4uinit.exe -show` is the supported way to make Windows rebuild the
;     on-disk icon cache. The in-memory notify alone can be defeated by the
;     persisted cache, and the persisted cache alone is not noticed until
;     something asks the shell to re-read it.
;
; Both are best-effort on purpose: a failure here must never fail the
; installation, so every call's result is popped and discarded and nothing
; is checked. The worst case is the behaviour we have today.
;
; NOT ATTEMPTED, DELIBERATELY
;
; Deleting `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` is the
; other "known" trick. It is not done here because Explorer holds those files
; open, so the delete either silently fails or, worse, races the shell into
; rewriting them mid-flight. `ie4uinit -show` asks the shell to do the same
; thing safely.

!macro NSIS_HOOK_POSTINSTALL
  ; Shortcuts and registry keys exist by this point, so the shell has
  ; something new to look at.
  DetailPrint "Refreshing Explorer's icon cache..."

  ; 1. Invalidate the running shell's caches. SHCNE_ASSOCCHANGED = 0x08000000.
  ;    (The three integer zeroes are the reserved flags/idl params.)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  ; 2. Then the install directory itself, so a shortcut whose target changed
  ;    is re-read. SHCNE_UPDATEDIR = 0x00001000, and the directory goes in
  ;    dwItem1 as a UTF-16 string.
  System::Call 'shell32::SHChangeNotify(i 0x00001000, i 0, w "$INSTDIR", i 0)'

  ; 3. Rebuild the persisted icon cache. -show is the Windows 8+/10/11 flag;
  ;    -ClearIconCache is the legacy one, so use whichever exists.
  ${If} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::ExecToLog '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
  ${EndIf}

  ; Belt and braces for an older shell where -show is not understood. Both are
  ; silent no-ops when unnecessary, and neither is allowed to abort the install.
  ${If} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::ExecToLog '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Same reasoning in reverse: after removal the user must not be left with a
  ; cached icon for an app that is gone (a "ghost" shortcut icon is the same
  ; bug, one step later).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ${If} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::ExecToLog '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
  ${EndIf}
!macroend
