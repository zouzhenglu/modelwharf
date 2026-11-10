@echo off
chcp 65001 >nul
title modelwharf
cd /d "%~dp0"
set WH_PORT=8317
rem Compatible old variable names (still honored):
rem set WH_ADMIN_PASSWORD=your-password
rem set WH_API_KEYS=wh-xxx,wh-yyy
echo [modelwharf] starting on port %WH_PORT% ...
echo [modelwharf] press Ctrl+C to stop
rem If node is not in PATH, uncomment and point to your node.exe:
rem set NODE_EXE=D:\Program Files\nodejs\node.exe
if not defined NODE_EXE set NODE_EXE=node
rem Duplicate start is prevented by src\server.js port probe.
"%NODE_EXE%" src\server.js
if errorlevel 1 goto :failed
echo.
echo [modelwharf] process exited.
echo [modelwharf] If you saw "port %WH_PORT% already in use" above, the gateway is
echo [modelwharf] already running in the background (started at logon) - this is normal.
echo [modelwharf] To restart: double-click stop.bat first, then start.bat.
goto :done

:failed
echo.
echo [modelwharf] start failed - see the error above.

:done
echo.
echo Press any key to close this window...
pause >nul
