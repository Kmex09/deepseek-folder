@echo off
rem ============================================================
rem  DeepSeek Folder diagnostic launcher (Windows)
rem  1) clears ELECTRON_RUN_AS_NODE (which would turn Electron into plain Node)
rem  2) enables Electron logging
rem  3) writes all startup output (including errors) to dsf-run.log
rem  Usage: double-click, or pass args: run-deepseek-folder.cmd --smoke
rem  ASCII-only on purpose: non-ASCII text breaks cmd parsing.
rem ============================================================
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_ENABLE_LOGGING=1"
set "LOG=%~dp0dsf-run.log"

set "APPEXE="
for %%F in ("dist\DeepSeek Folder 0.5.2.exe") do if exist "%%~fF" set "APPEXE=%%~fF"

echo ==== DeepSeek Folder startup log %DATE% %TIME% ==== > "%LOG%"
echo ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%] >> "%LOG%"
echo appdata=[%APPDATA%] >> "%LOG%"

if defined APPEXE (
  echo launching packaged app: %APPEXE% >> "%LOG%"
  "%APPEXE%" %* >> "%LOG%" 2>&1
  echo exit=%errorlevel% >> "%LOG%"
) else (
  echo packaged exe not found, falling back to npm start >> "%LOG%"
  call npm start --silent %* >> "%LOG%" 2>&1
  echo exit=%errorlevel% >> "%LOG%"
)

echo.
echo Startup log written to: %LOG%
type "%LOG%"
echo.
echo ---- app startup.log (%APPDATA%\DeepSeek Folder\startup.log) ----
if exist "%APPDATA%\DeepSeek Folder\startup.log" (
  powershell -NoProfile -Command "Get-Content -LiteralPath '%APPDATA%\DeepSeek Folder\startup.log' -Tail 40" 2>nul || type "%APPDATA%\DeepSeek Folder\startup.log"
) else (
  echo (not found - app may have failed before logging)
)
echo.
pause
