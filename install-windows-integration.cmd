@echo off
setlocal
set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%PS_EXE%" set "PS_EXE=%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows-integration.ps1"
if errorlevel 1 pause
