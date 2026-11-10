@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem modelwharf hidden start (pure batch, no console window).
rem How: conhost.exe --headless creates a hidden console to host node,
rem so node MainWindowHandle = 0 and no black window appears at logon.
rem If the system does not support --headless, fall back to start /min.
set "NODE_EXE=D:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "CONHOST=%SystemRoot%\System32\conhost.exe"

if exist "%CONHOST%" (
  start "modelwharf" /min "%CONHOST%" --headless "%NODE_EXE%" src\server.js
) else (
  start "modelwharf" /min "%NODE_EXE%" src\server.js
)
endlocal
