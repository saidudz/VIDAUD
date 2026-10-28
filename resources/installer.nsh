; VIDAUD custom NSIS installer script.
; Included by electron-builder (nsis.include) into the installer script header,
; so these macros are defined before the standard wizard pages are declared.

; Install for all users (per-machine) and skip the "Choose Installation Options"
; page entirely. With nsis.perMachine: true, electron-builder defines
; INSTALL_MODE_PER_ALL_USERS, which already removes that page; this macro is a
; safety fallback in case perMachine is ever turned off, so VIDAUD keeps
; installing machine-wide (Program Files) instead of asking the user.
!macro customInstallMode
  StrCpy $isForceMachineInstall "1"
  StrCpy $isForceCurrentInstall "0"
!macroend

; Show a proper Welcome page (with the custom sidebar image) as the first page,
; so the flow is: Welcome -> Installation Folder -> Install -> Completing.
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend
