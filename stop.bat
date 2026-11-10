@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title modelwharf - stop

rem 兼容旧/新环境变量与旧 PID 文件名（dsh.pid）
set "PORT=8317"
if defined WH_PORT set "PORT=%WH_PORT%"
if defined DSH_PORT set "PORT=%DSH_PORT%"
set "PIDFILE=%~dp0data\wharf.pid"
if not exist "%PIDFILE%" set "PIDFILE=%~dp0data\dsh.pid"

set "TARGET="

rem ---- 1) 优先用 PID 文件（用 for /f 读取，避免 if 块内 %PID% 提前展开）----
if exist "%PIDFILE%" (
  for /f "usebackq delims=" %%P in ("%PIDFILE%") do set "TARGET=%%P"
  if defined TARGET (
    echo [modelwharf] stopping PID !TARGET! ^(from %PIDFILE%^) ...
    taskkill /F /PID !TARGET! >nul 2>&1
    if errorlevel 1 (
      echo [modelwharf] PID !TARGET! 不存在，改按进程查找...
      set "TARGET="
    ) else (
      del "%PIDFILE%" >nul 2>&1
      goto :stopped
    )
  )
)

rem ---- 2) 按命令行查找 node src\server.js ----
rem 不用 netstat：部分 Windows 环境 netstat 不显示 LISTENING，查不到端口占用者。
echo [modelwharf] PID 文件无效，按进程查找 node src\server.js ...
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*src\server.js*' }).ProcessId"`) do set "TARGET=%%P"
if defined TARGET (
  echo [modelwharf] stopping PID !TARGET! ...
  taskkill /F /T /PID !TARGET! >nul 2>&1
  if errorlevel 1 (
    echo [modelwharf] taskkill 失败，尝试直接停止进程...
    powershell -NoProfile -Command "Stop-Process -Id !TARGET! -Force -ErrorAction SilentlyContinue"
  )
  del "%PIDFILE%" >nul 2>&1
  goto :stopped
)

rem ---- 3) 实在找不到，也别默默闪退 ----
echo [modelwharf] 没有找到运行中的网关进程（端口 %PORT% 可能已被其它程序占用，或网关未启动）。
echo.
echo 按任意键关闭本窗口...
pause >nul
exit /b 1

:stopped
echo [modelwharf] stopped.
echo.
echo 按任意键关闭本窗口...
pause >nul
exit /b 0
