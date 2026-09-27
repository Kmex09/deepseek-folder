@echo off
rem ============================================================
rem  DSF launcher (Windows, foreground single window)
rem  1) runs server.py  (web page + autosave to dsf-data.json)
rem  2) auto-opens browser  http://127.0.0.1:8000/
rem  Closing this window stops the server.
rem  (ASCII-only on purpose: Chinese text + chcp breaks cmd parsing)
rem ============================================================
cd /d "%~dp0"
title DSF - DeepSeek Session Folder
setlocal

set "PYCMD="
where python >nul 2>nul && set "PYCMD=python"
if not defined PYCMD (
  where python3 >nul 2>nul && set "PYCMD=python3"
)
if not defined PYCMD (
  where py >nul 2>nul && set "PYCMD=py"
)
if not defined PYCMD goto :nopython

rem --- make sure it is a real Python, not the Windows Store stub ---
%PYCMD% --version >nul 2>&1
if errorlevel 1 goto :nopython

echo.
echo  Starting DSF server with: %PYCMD%
echo  URL:  http://127.0.0.1:8000/
echo  The browser will open automatically. Close this window to stop.
echo.
%PYCMD% server.py
set "code=%errorlevel%"
echo.
if not "%code%"=="0" (
  echo  [error %code%] The server failed to start.
  echo  Please copy the error message shown above and send it to the developer,
  echo  or run it manually in this window:  %PYCMD% server.py
  pause
  exit /b %code%
)
exit /b 0

:nopython
echo.
echo  [ERROR] No usable Python 3 found (tried python / python3 / py).
echo  Install Python 3 and tick "Add Python to PATH":
echo      https://www.python.org/downloads/
echo  Then run this launcher again, or run manually:  python server.py
echo.
pause
exit /b 1
