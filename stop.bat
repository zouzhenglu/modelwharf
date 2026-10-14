@echo off
chcp 65001 >nul
set PORT=8317
rem 优先用 PID 文件
if exist "%~dp0datadsh.pid" (
  set /p PID=<"%~dp0datadsh.pid"
  echo [dsh-free-api] stopping PID %PID% ...
  taskkill /F /PID %PID% >nul 2>&1
  del "%~dp0datadsh.pid" >nul 2>&1
  echo [dsh-free-api] stopped.
  exit /b 0
)
rem 没有 PID 文件：按端口查找
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo [dsh-free-api] stopping PID %%p ...
  taskkill /F /PID %%p >nul 2>&1
)
echo [dsh-free-api] stopped.
