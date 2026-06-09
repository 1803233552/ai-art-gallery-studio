!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /IM "ai-studio-backend.exe" /F /T'
  nsExec::ExecToLog 'taskkill /IM "ai-art-gallery-studio-desktop.exe" /F /T'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /IM "ai-studio-backend.exe" /F /T'
  nsExec::ExecToLog 'taskkill /IM "ai-art-gallery-studio-desktop.exe" /F /T'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 复用 Tauri 自带卸载页的“删除应用程序数据”复选框。
  ; 勾选时，Tauri 会删除 $APPDATA\${BUNDLEID} 和 $LOCALAPPDATA\${BUNDLEID}；
  ; 这里补删 Python sidecar 后端实际使用的用户数据目录。
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\AI Art Gallery Studio"
    RMDir /r "$LOCALAPPDATA\AI Art Gallery Studio"
    RMDir /r "$APPDATA\AI 创意工坊"
    RMDir /r "$LOCALAPPDATA\AI 创意工坊"
  ${EndIf}
!macroend