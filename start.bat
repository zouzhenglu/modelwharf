@echo off
chcp 65001 >nul
title dsh-free-api
cd /d "%~dp0"
set DSH_PORT=8317
rem set DSH_ADMIN_PASSWORD=your-password
rem set DSH_API_KEYS=sk-xxx,sk-yyy
echo [dsh-free-api] starting on port %DSH_PORT% ...
echo [dsh-free-api] press Ctrl+C to stop
"D:\Program Files\nodejs\node.exe" src\server.js
pause
