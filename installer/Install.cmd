@echo off
rem Installs git-helper for the current user. Double-click to run.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
