@echo off
chcp 65001 >nul
set PORT=8317
rem 优先用 PID 文件（兼容旧名 dsh.pid）
set PIDFILE=%~dp0data\wharf.pid
if not exist "%PIDFILE%" set PIDFILE=%~dp0data\dsh.pid
if exist "%PIDFILE%" (
  set /p PID=<"%PIDFILE%"
  echo [modelwharf] stopping PID %PID% ...
  taskkill /F /PID %PID% >nul 2>&1
  del "%PIDFILE%" >nul 2>&1
  echo [modelwharf] stopped.
  exit /b 0
)
rem 没有 PID 文件：按端口查找
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo [modelwharf] stopping PID %%p ...
  taskkill /F /PID %%p >nul 2>&1
)
echo [modelwharf] stopped.
