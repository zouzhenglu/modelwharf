@echo off
chcp 65001 >nul
title modelwharf
cd /d "%~dp0"
set WH_PORT=8317
rem 兼容旧变量名（仍生效）：rem set DSH_ADMIN_PASSWORD=...
rem set WH_ADMIN_PASSWORD=your-password
rem set WH_API_KEYS=wh-xxx,wh-yyy
echo [modelwharf] starting on port %WH_PORT% ...
echo [modelwharf] press Ctrl+C to stop
rem 如 node 不在 PATH，可取消注释并指向你的 node.exe
rem set NODE_EXE=D:\Program Files\nodejs\node.exe
if not defined NODE_EXE set NODE_EXE=node
"%NODE_EXE%" src\server.js
pause
