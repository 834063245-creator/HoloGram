@echo off
cd /d D:\HoloGramHG\engine
cargo test routing::preflight --no-fail-fast 2>&1
echo EXIT_CODE=%ERRORLEVEL%
