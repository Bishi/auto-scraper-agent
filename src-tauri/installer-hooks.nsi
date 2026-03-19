!include "LogicLib.nsh"

; ── PREINSTALL ───────────────────────────────────────────────────────────────
; Runs before file extraction, registry key writes, and shortcut creation.
!macro NSIS_HOOK_PREINSTALL
  ; Kill any running instances so their file handles are released before
  ; the installer tries to overwrite them.
  DetailPrint "Stopping running Auto-Scraper Agent..."
  nsExec::ExecToLog 'taskkill /F /IM "Auto-Scraper Agent.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "scraper-node.exe" /T'
  Sleep 1500

  ; Use timestamp-based skip for large binaries that rarely change between
  ; releases (Chromium headless-shell, scraper-node SEA).  If the installed
  ; file is the same age or newer, NSIS skips the extraction — saving several
  ; seconds and avoiding unnecessary disk writes.
  SetOverwrite ifnewer
!macroend

; ── POSTINSTALL ──────────────────────────────────────────────────────────────
; Runs after files, registry keys, and shortcuts have been created.
; Restore normal overwrite mode and remove any desktop shortcut Tauri may have
; created (belt-and-suspenders — tauri.conf.json shortcuts.desktop is false).
!macro NSIS_HOOK_POSTINSTALL
  SetOverwrite on
  Delete "$DESKTOP\${MAINBINARYNAME}.lnk"
!macroend

; ── POSTUNINSTALL ─────────────────────────────────────────────────────────────
; Clean up any leftover desktop shortcut on uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\${MAINBINARYNAME}.lnk"
!macroend
