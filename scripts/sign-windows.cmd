@echo off
REM Lantai Windows code-signing forwarder.
REM Calls sign-windows.ps1 with a self-locating path (%~dp0), so Tauri's
REM beforeBundleCommand / bundle.windows.signCommand do not need to know where
REM the repo lives on disk. Callers (build.cmd / release.yml) put <repo>\scripts
REM on PATH and pass this file by its bare name, which works no matter what
REM working directory the caller uses.
REM
REM NOTE: keep this file ASCII-only. cmd.exe reads .cmd/.bat in the OEM codepage,
REM so UTF-8 non-ASCII comments get mis-parsed and executed as commands
REM (observed 2026-10-14: a Chinese comment made cmd exit non-zero).
REM
REM Contract: no argument  -> sign the default target set
REM           one path      -> sign that file (-Files <path>, as Tauri passes %1)
setlocal
if "%~1"=="" (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0sign-windows.ps1"
) else (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0sign-windows.ps1" -Files "%~1"
)
exit /b %ERRORLEVEL%
