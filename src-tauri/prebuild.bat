:: prebuild.bat — build frontend for Tauri bundling (Windows native)
@echo off
echo [prebuild] building frontend...
cd /d "%~dp0..\src-ui"
call npm run build
echo [prebuild] done
