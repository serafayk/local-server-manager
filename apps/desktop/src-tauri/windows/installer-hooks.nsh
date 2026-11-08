!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removendo tarefa de inicializacao do Local Server Manager..."
  nsExec::Exec 'schtasks /Delete /TN "Local Server Manager Engine" /F'
!macroend
