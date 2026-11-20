@echo off
setlocal EnableExtensions

REM ============================================================
REM  One-click start: Agent Insight platform from local source
REM
REM  Windows counterpart of scripts/start.sh:
REM    start-windows.bat          dev mode (next dev, hot reload)
REM    start-windows.bat --prod   production build + npm start
REM
REM  Usage:
REM    double-click this bat          dev mode  (next dev, hot reload)
REM    this bat --prod                prod mode (next build + npm start)
REM    this bat --prod --rebuild      force a fresh production build
REM    this bat --port 3001           override the platform port
REM
REM  What it does:
REM    1. checks Node.js 20+ and that the platform port is free
REM    2. runs "npm install" only when node_modules is missing
REM    3. creates %USERPROFILE%\.agent-insight (config + data dirs)
REM    4. syncs the SQLite schema (prisma db push, never --accept-data-loss)
REM    5. starts the platform from this source checkout
REM
REM  Data root : %USERPROFILE%\.agent-insight
REM  Database  : %USERPROFILE%\.agent-insight\data\witty_insight.db
REM  Evaluator : not started here (needs Linux/WSL2, see scripts/evaluator.sh)
REM
REM  NOTE: pure ASCII on purpose (cmd GBK codepage safety).
REM ============================================================

REM Capture the script location before any "shift": shift also moves %0,
REM which would turn %~dp0 into the drive root.
set "DIR=%~dp0"
set "ROOT=%DIR%.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "SCRIPT_NAME=%~nx0"
set "MODE=dev"
set "REBUILD=0"
set "PLATFORM_PORT="

:parse_args
if "%~1"=="" goto :args_ready
if /I "%~1"=="--prod" (
  set "MODE=prod"
  shift
  goto :parse_args
)
if /I "%~1"=="--rebuild" (
  set "REBUILD=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--port" (
  set "PLATFORM_PORT=%~2"
  shift
  shift
  goto :parse_args
)
if /I "%~1"=="--help" goto :usage
if /I "%~1"=="-h" goto :usage
echo   [ERROR] Unknown option: %~1
goto :usage

:usage
echo.
echo   Usage: %SCRIPT_NAME% [--prod] [--rebuild] [--port PORT]
echo.
echo     --prod      production mode: npm run build + npm start
echo     --rebuild   with --prod, rebuild even if a build already exists
echo     --port N    platform port, default 3000
echo.
exit /b 1

:args_ready
if not defined PLATFORM_PORT set "PLATFORM_PORT=3000"
for /f "delims=0123456789" %%i in ("%PLATFORM_PORT%") do set "PLATFORM_PORT="
if not defined PLATFORM_PORT goto :bad_port

echo ========================================
echo   Agent Insight - local source start
echo   Mode      : %MODE%
echo   Platform  : http://localhost:%PLATFORM_PORT%
echo   Data root : %USERPROFILE%\.agent-insight
echo ========================================
echo.

REM ---------- [1/4] Preflight ----------
echo [1/4] Checking prerequisites...

where node >nul 2>&1
if errorlevel 1 goto :no_node
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :no_node
if %NODE_MAJOR% LSS 20 goto :old_node

if not exist "%ROOT%\package.json" goto :bad_root
cd /d "%ROOT%" 2>nul
if errorlevel 1 goto :bad_root
echo       Node.js v%NODE_MAJOR%, source root %ROOT%

call :check_port
if errorlevel 1 exit /b 1
echo       Port %PLATFORM_PORT% is available.

REM ---------- [2/4] Environment and dependencies ----------
echo.
echo [2/4] Preparing config and dependencies...
set "APP_HOME=%USERPROFILE%\.agent-insight"
if not exist "%APP_HOME%" mkdir "%APP_HOME%"
if not exist "%APP_HOME%\data" mkdir "%APP_HOME%\data"
if not exist "%APP_HOME%\logs" mkdir "%APP_HOME%\logs"
if not exist "%APP_HOME%\.env" (
  copy /y "%ROOT%\.env.example" "%APP_HOME%\.env" >nul
  echo       Created %APP_HOME%\.env from .env.example
)

REM The prisma CLI does not read %APP_HOME%\.env, so pin DATABASE_URL here.
REM Empty / missing value means the default SQLite file under the data root.
set "ENV_DATABASE_URL="
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /R /C:"^DATABASE_URL=" "%APP_HOME%\.env" 2^>nul`) do set "ENV_DATABASE_URL=%%b"
if defined ENV_DATABASE_URL goto :db_from_env
set "APP_HOME_FWD=%APP_HOME:\=/%"
set "DATABASE_URL=file:%APP_HOME_FWD%/data/witty_insight.db"
goto :db_ready
:db_from_env
set "DATABASE_URL=%ENV_DATABASE_URL%"
:db_ready
set "AGENT_INSIGHT_HOME=%APP_HOME%"

if not exist "node_modules\next\package.json" (
  echo       node_modules is missing, running npm install - first run takes a while...
  call npm install
  if errorlevel 1 goto :install_failed
)
if not exist "node_modules\.prisma\client\index.js" (
  echo       Generating Prisma client...
  call npx prisma generate
  if errorlevel 1 goto :generate_failed
)
echo       Config and dependencies are ready.

REM ---------- [3/4] Database schema ----------
echo.
echo [3/4] Syncing SQLite schema (%DATABASE_URL%)...
node scripts\prepare-ras-sqlite-schema.js
if errorlevel 1 goto :schema_failed
REM "< nul" keeps prisma from prompting "reset database?" on destructive diffs.
call npx prisma db push --skip-generate < nul
if errorlevel 1 goto :schema_failed

REM ---------- [4/4] Start ----------
echo.
echo [4/4] Starting platform...
if /I "%MODE%"=="prod" goto :start_prod

echo       Dev mode: pages compile on first visit.
echo       Open http://localhost:%PLATFORM_PORT% and press Ctrl+C here to stop.
echo.
call npm run dev -- --port %PLATFORM_PORT% -H 0.0.0.0
set "RC=%ERRORLEVEL%"
echo.
echo Platform stopped (exit code %RC%).
exit /b %RC%

:start_prod
set "STANDALONE_SERVER=.next\standalone\server.js"
if "%REBUILD%"=="1" goto :build_prod
if not exist "%STANDALONE_SERVER%" goto :build_prod
echo       Reusing the existing production build.
goto :run_prod

:build_prod
echo       Building production bundle (several minutes)...
set "NODE_OPTIONS=--max-old-space-size=4096"
call npm run build
if errorlevel 1 goto :build_failed
set "NODE_OPTIONS="

:run_prod
if not exist "%STANDALONE_SERVER%" goto :build_failed
set "PORT=%PLATFORM_PORT%"
set "HOSTNAME=0.0.0.0"
echo       Open http://localhost:%PLATFORM_PORT% and press Ctrl+C here to stop.
echo.
call npm start
set "RC=%ERRORLEVEL%"
echo.
echo Platform stopped (exit code %RC%).
exit /b %RC%

REM ---------- helpers ----------
REM Fails when another process already listens on %PLATFORM_PORT%.
REM Dev servers need a moment to release the port after Ctrl+C.
:check_port
set /a PORT_WAIT=0
:check_port_loop
set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /R /C:":%PLATFORM_PORT% .*LISTENING"') do set "PORT_PID=%%p"
if not defined PORT_PID exit /b 0
if %PORT_WAIT% GEQ 4 goto :check_port_fail
set /a PORT_WAIT+=2
timeout /t 2 /nobreak >nul 2>&1
goto :check_port_loop

:check_port_fail
echo   [ERROR] Port %PLATFORM_PORT% is already in use by PID %PORT_PID%.
echo           Stop that process and retry, or start with --port 3001.
pause
exit /b 1

REM ---------- failures ----------
:bad_port
echo   [ERROR] --port needs an integer between 1 and 65535.
pause
exit /b 1

:no_node
echo   [ERROR] Node.js not found on PATH. Install Node.js 20 or newer.
pause
exit /b 1

:old_node
echo   [ERROR] Node.js v%NODE_MAJOR% is too old. This project needs Node.js 20 or newer.
pause
exit /b 1

:bad_root
echo   [ERROR] Cannot locate the repository root at %ROOT%
echo           (expected %ROOT%\package.json).
pause
exit /b 1

:install_failed
echo   [ERROR] npm install failed.
pause
exit /b 1

:generate_failed
echo   [ERROR] prisma generate failed.
pause
exit /b 1

:schema_failed
echo   [ERROR] Database schema sync failed; refusing to start.
echo           If prisma reported a destructive change, back up the database and
echo           migrate it manually. See the message above.
pause
exit /b 1

:build_failed
echo   [ERROR] Production build failed.
pause
exit /b 1
