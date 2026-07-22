@echo off
REM HoloGram CLI wrapper — delegates to hologram-engine.exe
REM Usage:
REM   hologram run ^<tool^> [project_path] [--key value ...]
REM   hologram run --list
REM   hologram serve [--project-root ^<path^>]
REM   hologram --version
REM   hologram --help

setlocal

set "SCRIPT_DIR=%~dp0"

REM Find engine binary — same dir, then engine-bin\
set "ENGINE="
if exist "%SCRIPT_DIR%hologram-engine.exe" (
    set "ENGINE=%SCRIPT_DIR%hologram-engine.exe"
) else if exist "%SCRIPT_DIR%..\engine-bin\hologram-engine.exe" (
    set "ENGINE=%SCRIPT_DIR%..\engine-bin\hologram-engine.exe"
)

if "%ENGINE%"=="" (
    echo error: hologram-engine.exe not found. >&2
    echo   Expected next to this script or in engine-bin\ >&2
    exit /b 1
)

"%ENGINE%" %*
exit /b %ERRORLEVEL%
