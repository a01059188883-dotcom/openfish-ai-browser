@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install Node.js and reopen this window.
  pause
  exit /b 1
)
node scripts\start-local.js
if errorlevel 1 pause
