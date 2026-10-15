@echo off
chcp 65001 >nul
title dsh-free-api
cd /d "%~dp0"
set DSH_PORT=8317
rem set DSH_ADMIN_PASSWORD=your-password
rem set DSH_API_KEYS=sk-xxx,sk-yyy
echo [dsh-free-api] starting on port %DSH_PORT% ...
echo [dsh-free-api] press Ctrl+C to stop
rem 如 node 不在 PATH，可取消注释并指向你的 node.exe
rem set NODE_EXE=D:\Program Files\nodejs\node.exe
if not defined NODE_EXE set NODE_EXE=node
"%NODE_EXE%" src\server.js
pause
