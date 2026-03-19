!include "LogicLib.nsh"

; Global variable — stores the user's desktop shortcut choice across hook macros.
Var CreateDesktopShortcut

; ── PREINSTALL ───────────────────────────────────────────────────────────────
; Runs before file extraction, registry key writes, and shortcut creation.
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping running Auto-Scraper Agent..."
  nsExec::ExecToLog 'taskkill /F /IM "Auto-Scraper Agent.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "scraper-node.exe" /T'
  Sleep 1500

  ; Ask whether to create a desktop shortcut.
  ; MB_DEFBUTTON2 makes "No" the default — user must actively click Yes to get one.
  StrCpy $CreateDesktopShortcut "1"
  MessageBox MB_YESNO|MB_DEFBUTTON2 "Create a desktop shortcut for Auto-Scraper Agent?" IDYES +2
  StrCpy $CreateDesktopShortcut "0"
!macroend

; ── POSTINSTALL ──────────────────────────────────────────────────────────────
; Runs after files, registry keys, and shortcuts have been created.
; Remove the desktop shortcut Tauri created if the user opted out above.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $CreateDesktopShortcut == "0"
    Delete "$DESKTOP\${MAINBINARYNAME}.lnk"
  ${EndIf}
!macroend

; ── POSTUNINSTALL ─────────────────────────────────────────────────────────────
; Clean up desktop shortcut on uninstall in case it was left behind.
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\${MAINBINARYNAME}.lnk"
!macroend
