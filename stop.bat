@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title modelwharf - stop

rem Compatible old/new env vars and legacy PID file (dsh.pid)
set "PORT=8317"
if defined WH_PORT set "PORT=%WH_PORT%"
if defined DSH_PORT set "PORT=%DSH_PORT%"
set "PIDFILE=%~dp0data\wharf.pid"
if not exist "%PIDFILE%" set "PIDFILE=%~dp0data\dsh.pid"

set "TARGET="

rem ---- 1) Prefer PID file (read with for /f so %PID% is not expanded too early) ----
if exist "%PIDFILE%" (
  for /f "usebackq delims=" %%P in ("%PIDFILE%") do set "TARGET=%%P"
  if defined TARGET (
    echo [modelwharf] stopping PID !TARGET! ^(from %PIDFILE%^) ...
    taskkill /F /PID !TARGET! >nul 2>&1
    if errorlevel 1 (
      echo [modelwharf] PID !TARGET! not found, falling back to process lookup...
      set "TARGET="
    ) else (
      del "%PIDFILE%" >nul 2>&1
      goto :stopped
    )
  )
)

rem ---- 2) Fall back to command line node src\server.js ----
rem Do not use netstat: some Windows setups do not show LISTENING, so the port owner is missed.
echo [modelwharf] PID file invalid, looking up node src\server.js ...
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*src\server.js*' }).ProcessId"`) do set "TARGET=%%P"
if defined TARGET (
  echo [modelwharf] stopping PID !TARGET! ...
  taskkill /F /T /PID !TARGET! >nul 2>&1
  if errorlevel 1 (
    echo [modelwharf] taskkill failed, trying to stop the process directly...
    powershell -NoProfile -Command "Stop-Process -Id !TARGET! -Force -ErrorAction SilentlyContinue"
  )
  del "%PIDFILE%" >nul 2>&1
  goto :stopped
)

rem ---- 3) If nothing is found, do not exit silently ----
echo [modelwharf] no running gateway process found (port %PORT% may be occupied by another program, or the gateway is not running).
echo.
echo Press any key to close this window...
pause >nul
exit /b 1

:stopped
echo [modelwharf] stopped.
echo.
echo Press any key to close this window...
pause >nul
exit /b 0
