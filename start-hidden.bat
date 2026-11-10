@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem modelwharf 隐藏启动（纯 bat，无黑窗口）。
rem 原理：conhost.exe --headless 创建一个不显示窗口的控制台来承载 node，
rem 因此 node 的 MainWindowHandle = 0，登录时不会弹出黑框。
rem 若系统不支持 --headless，则退回 start /min（最小化窗口）。
set "NODE_EXE=D:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "CONHOST=%SystemRoot%\System32\conhost.exe"

if exist "%CONHOST%" (
  start "modelwharf" /min "%CONHOST%" --headless "%NODE_EXE%" src\server.js
) else (
  start "modelwharf" /min "%NODE_EXE%" src\server.js
)
endlocal
