@echo off
rem Superbrain console launcher: start the local backend if needed, then open the page.
node "%~dp0app\tools\ui.mjs"
if errorlevel 1 (
  echo.
  echo Failed. Press any key to close.
  pause >nul
)
