@echo off
rem =====================================================================
rem ECG Socket Channel Router - one-click setup + run (Windows)
rem
rem Double-click this file. It runs setup-and-run.ps1 with ExecutionPolicy
rem Bypass, so no PowerShell policy change is needed on the machine.
rem
rem   1) Check Python 3.10+ / Node.js 18+
rem   2) npm install for web/viewer, web/admin (first run only)
rem   3) Launch all 6 services in order (router uses bundled exe)
rem
rem After start: open http://localhost:5174 and run [Test > DB Reset] once.
rem =====================================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-and-run.ps1" %*
echo.
pause
