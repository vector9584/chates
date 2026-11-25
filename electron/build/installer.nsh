; CHATES NSIS install hooks (electron-builder include entry)
;
; IMPORTANT: NSIS parses scripts using the system ANSI codepage, NOT UTF-8.
; Any non-ASCII byte here can swallow the line break and corrupt the next
; statement, which produces a build that compiles cleanly but misbehaves.
; Keep this file pure ASCII -- English comments only.
; Check: LC_ALL=C grep -c '[^ -~]' installer.nsh   must be 0
;
; Duties:
;   1. Stop running CHATES / node before install/uninstall, otherwise Windows
;      file locks make the copy/delete fail with an opaque "cannot delete file".
;   2. Never touch user data (%APPDATA%\CHAT...). Config, knowledge base and
;      sessions live there; deleting them is data loss.
;
; 2026-11-25 pitfall: an unconditional MessageBox in customUnInstall hangs
; silent uninstall (/S) forever -- nobody can click OK. Observed stuck >500s.
; The leftover Un_A.exe in %TEMP%\~nsuA.tmp then made every later installer
; crash with 0xC0000005 in ~4s with empty logs. Every UI element must be
; guarded by ${Silent}.

!macro customInit
  ; Ignore taskkill exit codes: it returns non-zero when the process is absent,
  ; and that must not abort the install.
  ;
  ; 2026-11-25: the real binary is the product name -- C-H-A-T, E with a grave
  ; accent, S -- NOT chates-desktop.exe. Killing the old name left the app running, the file
  ; copy hit a lock and the installer sat there for 8+ minutes with no output.
  ; This file must stay ASCII, so the accented name cannot be written literally --
  ; "CHAT?S.exe" with the ? wildcard matches it without spelling the accent.
  ; /T takes the node + hermes children down too; they hold files under $INSTDIR.
  nsExec::Exec 'taskkill /F /IM "chates-desktop.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /FI "IMAGENAME eq CHAT?S.exe"'
  Pop $0
  Sleep 800
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /F /IM "chates-desktop.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /FI "IMAGENAME eq CHAT?S.exe"'
  Pop $0
  Sleep 500

  ; Only prompt in interactive uninstall. ${Silent} covers /S and the
  ; uninstall that an upgrade performs internally.
  ${ifNot} ${Silent}
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION \
        "User configuration and sessions are kept in:$\r$\n$APPDATA$\r$\n$\r$\nDelete the CHATES folder there manually if you want a full wipe.$\r$\n$\r$\nOpen APPDATA now?" \
        IDOK openappdata IDCANCEL done
      openappdata:
        ExecShell "open" "$APPDATA"
      done:
    ${endIf}
  ${endIf}
!macroend
