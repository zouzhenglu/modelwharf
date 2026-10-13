@echo off
rem dsh-free-api startup script (Windows)
cd /d "%~dp0"
set DSH_PORT=8317
rem set DSH_ADMIN_PASSWORD=your-password
rem set DSH_API_KEYS=sk-xxx,sk-yyy
"D:\Program Files\nodejs\node.exe" src\server.js
