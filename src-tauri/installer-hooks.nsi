; Kill running instances before installing new files.
; Runs before file extraction in Tauri's install section.
!macro customInstall
  DetailPrint "Stopping running Auto-Scraper Agent..."
  nsExec::ExecToLog 'taskkill /F /IM "Auto-Scraper Agent.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "scraper-node.exe" /T'
  Sleep 1500
!macroend
