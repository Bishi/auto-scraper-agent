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
  ; releases (Chromium headless-shell ~150 MB, scraper-node SEA).
  ; If the installed file is the same age or newer, NSIS skips extraction.
  SetOverwrite ifnewer
!macroend

; ── POSTINSTALL ──────────────────────────────────────────────────────────────
; Restore normal overwrite mode after the large-binary skip window.
!macro NSIS_HOOK_POSTINSTALL
  SetOverwrite on
!macroend
