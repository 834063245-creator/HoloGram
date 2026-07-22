@echo off
REM HoloGram CLI installer — copies wrapper + engine to a PATH directory.
REM
REM Usage:
REM   install.cmd          install to %USERPROFILE%\bin (no admin needed)
REM   install.cmd --admin  install to C:\Program Files\HoloGram (needs admin)

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "DEST=%USERPROFILE%\bin"

if "%~1"=="--admin" (
    set "DEST=C:\Program Files\HoloGram"
)

REM Create destination
if not exist "%DEST%" mkdir "%DEST%"

REM Copy engine binary
if exist "%SCRIPT_DIR%hologram-engine.exe" (
    copy /Y "%SCRIPT_DIR%hologram-engine.exe" "%DEST%\hologram-engine.exe" >nul
    echo   OK %DEST%\hologram-engine.exe
)

REM Copy CLI wrapper
copy /Y "%SCRIPT_DIR%hologram.cmd" "%DEST%\hologram.cmd" >nul
echo   OK %DEST%\hologram.cmd

REM Add to user PATH (not --admin mode)
if not "%~1"=="--admin" (
    for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
    if defined USER_PATH (
        echo !USER_PATH! | findstr /C:"%DEST%" >nul
        if errorlevel 1 (
            setx PATH "%USER_PATH%;%DEST%" >nul
            echo.
            echo Added %DEST% to user PATH.
            echo Please open a new terminal for changes to take effect.
        ) else (
            echo %DEST% is already on PATH.
        )
    ) else (
        setx PATH "%DEST%" >nul
        echo.
        echo Added %DEST% to user PATH.
        echo Please open a new terminal for changes to take effect.
    )
)

echo.
echo Done. Run: hologram --version
