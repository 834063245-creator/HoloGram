@echo off
REM Lantai product integrity-label guard (2026-10-15 incident legislation).
REM
REM Why this exists: an external tool (measured on this machine: the DSH
REM workspace-write sandbox) may stamp the workspace ROOT with a STANDING,
REM INHERITABLE Low mandatory integrity label. Every executable built inside that
REM tree inherits it, and Windows lowers a new process's integrity to the image
REM label, so the app can never write the user profile again:
REM   ~/.lantai/providers.yml, %APPDATA%\com.lantai.app\... -> os error 5 (access denied)
REM and restarting does not help (the label is attached to the file).
REM A Low process cannot raise its own label (icacls exits 1299: SeRelabelPrivilege
REM is required), so the product cannot self-heal at runtime - build time is the
REM only place that can. Full chain: src-tauri/src/integrity.rs header.
REM
REM An explicit Medium label on the file survives later inheritance propagation,
REM so pinning it here is durable for the produced binary.
setlocal
set RC=0
for %%F in (target\release\lantai.exe target\release\hologram-engine.exe target\release\hologram-lspd.exe) do (
  if exist "%%F" (
    icacls "%%F" /setintegritylevel Medium >nul 2>&1
    if errorlevel 1 (
      echo [integrity] FAILED to pin Medium label: %%F
      set RC=1
    ) else (
      echo [integrity] Medium label pinned: %%F
    )
  )
)
exit /b %RC%
