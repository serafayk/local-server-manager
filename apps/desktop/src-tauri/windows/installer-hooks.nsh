; Encerra o app e o Engine (incluindo os processos gerenciados) para liberar
; node.exe e engine.mjs antes de copiar/remover arquivos.
; O Engine roda separado da janela; sem isso o instalador falha ao sobrescrever
; resources\engine\node.exe (arquivo em uso).
!macro LSM_STOP_RUNNING
  DetailPrint "Encerrando o Local Server Manager e o Engine..."
  nsExec::Exec 'taskkill /F /IM local-server-manager.exe /T'
  FileOpen $0 "$TEMP\lsm-stop-engine.ps1" w
  FileWrite $0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $0 "Get-CimInstance Win32_Process | Where-Object { $$_.CommandLine -like '*engine.mjs*' } | ForEach-Object { & taskkill.exe /PID $$_.ProcessId /T /F | Out-Null }$\r$\n"
  FileClose $0
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\lsm-stop-engine.ps1"'
  Delete "$TEMP\lsm-stop-engine.ps1"
  Sleep 1200
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LSM_STOP_RUNNING
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LSM_STOP_RUNNING

  DetailPrint "Removendo tarefa de inicializacao do Local Server Manager..."
  nsExec::Exec 'schtasks /Delete /TN "Local Server Manager Engine" /F'
!macroend
