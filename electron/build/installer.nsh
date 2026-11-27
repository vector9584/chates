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

  ; The shell spawns node.exe (panel/monitor) and python.exe (kernel). /T needs
  ; a matching root PID; once the shell is gone those children get reparented,
  ; survive, and keep handles open into $INSTDIR. That is the "installer sits
  ; at 60% for minutes" symptom reported on 2026-11-26.
  ;
  ; Earlier attempts tried to kill those children by path. That needs a
  ; PowerShell pipeline with three levels of quoting inside an NSIS string --
  ; unreadable, and impossible to verify without a real installer run.
  ;
  ; The installer does not actually need the processes dead. It needs the
  ; target directory free. Directory rename is an atomic check for exactly
  ; that, and it does not care what the process is called:
  ;   - renamed OK      -> nothing holds it, rename back, carry on
  ;   - rename fails    -> something is still running; tell the user plainly
  ;                        instead of letting the copy phase stall silently
  ; First install: $INSTDIR does not exist yet, and Rename would "fail" for the
  ; wrong reason -- that must not show the "still running" prompt.
  IfFileExists "$INSTDIR\*.*" 0 chates_unlocked
  ClearErrors
  Rename "$INSTDIR" "$INSTDIR.lock"
  IfErrors chates_locked
    Rename "$INSTDIR.lock" "$INSTDIR"
    Goto chates_unlocked
  chates_locked:
    ${ifNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_OK \
        "CHATES is still running. Please quit it from the tray, then click OK to continue."
    ${endIf}
  chates_unlocked:
  Sleep 1500
!macroend

; Expand the runtime tarball right after files land.
; The payload ships as resources/chates.tgz (one entry) instead of ~20k loose
; files. NSIS drives its progress bar per file entry, so the loose-file layout
; made the bar fill once during decompress, reset near 60%, then sit still for
; minutes while thousands of tiny files were written -- users read that as a
; hang. One archive keeps the bar monotonic and honest.
; Windows 10 1803+ ships bsdtar, and bsdtar accepts -xzf / -C, so this stays
; portable without bundling anything.
!macro customInstall
  IfFileExists "$INSTDIR\resources\chates.tgz" 0 chates_no_tar
    DetailPrint "Expanding runtime (this takes a minute)..."
    ; 2026-11-27 fix: used to extract to $INSTDIR\resources (flat), which produced
    ; resources\app + resources\runtime + resources\data, while main.js extracts
    ; the SAME tarball to resources\chates\ and resolveRoots() only looks there.
    ; Result: two parallel layouts, ~100 MB duplicated, and the runtime the shell
    ; actually used (resources\chates\runtime) was a second copy. Extract to the
    ; one place the code reads: resources\chates\.
    CreateDirectory "$INSTDIR\resources\chates"
    nsExec::ExecToLog 'tar -xzf "$INSTDIR\resources\chates.tgz" -C "$INSTDIR\resources\chates"'
    Pop $0
    ; 0 = success, 2 = partial. Anything else is worth surfacing in the log
    ; but must not abort: main.js extracts again on first run as a fallback.
    DetailPrint "runtime expand exit=$0"
  chates_no_tar:
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
