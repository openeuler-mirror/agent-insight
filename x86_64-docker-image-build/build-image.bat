@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

REM ============================================================
REM  Agent Insight - offline image build (x86_64 / linux-amd64)
REM  The generated Dockerfile is the repository Dockerfile.local
REM  with the download hosts swapped for domestic mirrors, plus a
REM  deps stage so a code change does not discard the dependency
REM  layers. Node version and package list still follow the repo.
REM
REM  Usage: build-image.bat [repo-path]
REM
REM  One docker build with --pull on every run: unchanged layers are
REM  reused by Docker's own layer cache, changed ones are rebuilt.
REM  Each step prints its elapsed seconds and the total is written
REM  to BUILD-INFO.txt.
REM
REM  Build materials stay in this folder; the repository is read-only.
REM  This file is kept pure ASCII on purpose: cmd.exe decodes .bat by the
REM  active code page, and UTF-8 Chinese comments can break command parsing.
REM ============================================================

set "ROOT=%~dp0"
set "REPO=%~1"
if not defined REPO for %%i in ("%ROOT%..") do set "REPO=%%~fi"

set "APT_MIRROR=mirrors.huaweicloud.com"
set "NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/"
set "NODE_MIRROR_PREFIX=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/"
set "DF_NAME=Dockerfile.agent-insight.single"
set "PLATFORM=linux/amd64"
REM Drop --pull if the registry is unreachable and a cached node image must do.
set "PULL_FLAG=--pull"

if not exist "%REPO%\package.json" (
  echo [ERROR] repository not found: %REPO%
  echo Usage: build-image.bat [repo-path]
  goto :fail
)

docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker daemon is not running, or Docker Desktop is in Windows container mode.
  echo         Start Docker Desktop and switch to Linux containers, then run this again.
  goto :fail
)

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(ConvertFrom-Json (Get-Content '%REPO%\package.json' -Raw)).version"`) do set "VER=%%v"
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"`) do set "STAMP=%%t"
if not defined VER (
  echo [ERROR] cannot read version from package.json
  goto :fail
)
if not defined STAMP (
  echo [ERROR] cannot get current time
  goto :fail
)
for /f "usebackq delims=" %%c in (`git -C "%REPO%" rev-parse --short HEAD`) do set "COMMIT=%%c"
if not defined COMMIT (
  echo [ERROR] cannot read git commit
  goto :fail
)
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()"`) do set "T0=%%t"

set "BUILD_ID=%VER%-amd64-%STAMP%"
set "TAG=agent-insight:%VER%-amd64"
set "TAR_FILE=agent-insight-%VER%-amd64.tar"
set "IMG_DIR=%ROOT%images"

echo ============================================================
echo  Agent Insight offline image build ^(single Dockerfile^)
echo ------------------------------------------------------------
echo  source dir : %REPO%
echo  version    : %VER%
echo  image tag  : %TAG%
echo  apt mirror : %APT_MIRROR%
echo  npm mirror : %NPM_REGISTRY%
echo  node mirror: %NODE_MIRROR_PREFIX%
echo  dockerfile : %DF_NAME% ^(mirrors + deps stage^)
echo ============================================================
echo.

echo [1/4] Preparing build files...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%make-dockerfile-single.ps1" -Repo "%REPO%" -Out "%ROOT%%DF_NAME%" -NodeMirrorPrefix "%NODE_MIRROR_PREFIX%"
if errorlevel 1 (
  echo [ERROR] cannot generate %DF_NAME% from Dockerfile.local
  goto :fail
)
copy /y "%REPO%\Dockerfile.local.dockerignore" "%ROOT%%DF_NAME%.dockerignore" >nul
if errorlevel 1 (
  echo [ERROR] cannot copy Dockerfile.local.dockerignore
  goto :fail
)
REM The repository root is the build context and this folder sits inside it.
REM Docker only honours patterns relative to the context root, so the repo's
REM "*.tar" rule does not match images\*.tar. A previously exported package
REM (~2.5GB) would then be COPYed into the image, swept into .next/standalone
REM and break "npm pack" with ERR_OUT_OF_RANGE: data is too long.
for %%i in ("%ROOT:~0,-1%") do set "CTX_DIR=%%~nxi"
>> "%ROOT%%DF_NAME%.dockerignore" echo %CTX_DIR%
>> "%ROOT%%DF_NAME%.dockerignore" echo **/*.tar
>> "%ROOT%%DF_NAME%.dockerignore" echo **/*.tar.*
>> "%ROOT%%DF_NAME%.dockerignore" echo **/*.tgz
for /f "usebackq tokens=2 delims==" %%n in (`findstr /b /c:"# NODE_IMAGE=" "%ROOT%%DF_NAME%"`) do set "NODE_REF=%%n"
if not defined NODE_REF (
  echo [ERROR] cannot read node image from %DF_NAME%
  goto :fail
)
echo [OK] build files ready, node image: !NODE_REF!
call :elapsed

echo.
echo [2/4] Building application image, this may take a while...
echo       prepared from the repository Dockerfile.local on every run
docker build %PULL_FLAG% --platform %PLATFORM% -f "%ROOT%%DF_NAME%" --build-arg APT_MIRROR=%APT_MIRROR% --build-arg NPM_REGISTRY=%NPM_REGISTRY% --build-arg LOCAL_BUILD_ID=%BUILD_ID% -t %TAG% "%REPO%"
if errorlevel 1 (
  echo [ERROR] build failed, see log above
  goto :fail
)
docker image inspect %TAG% --format "      arch={{.Architecture}} user={{.Config.User}} id={{.Id}}"
call :elapsed

echo.
echo [3/4] Verifying image...
set "VDIR=%TEMP%\ai-pkg-verify"
if exist "%VDIR%" rmdir /s /q "%VDIR%"
mkdir "%VDIR%" >nul 2>&1
docker rm -f ai-pkg-verify >nul 2>&1
docker run -d --name ai-pkg-verify -p 13000:3000 -v "%VDIR%:/data/agent-insight" %TAG% >nul
if errorlevel 1 (
  echo [ERROR] failed to start verification container.
  goto :fail
)
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 40;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:13000/ -TimeoutSec 3; if($r.StatusCode -lt 500){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 2 }; if($ok){ exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [ERROR] HTTP check failed. Container logs:
  docker logs --tail=100 ai-pkg-verify
  docker rm -f ai-pkg-verify >nul 2>&1
  goto :fail
)
docker exec ai-pkg-verify sh -c "node -v && python3 -V && test -x /app/node_modules/.bin/opencode"
if errorlevel 1 (
  echo [ERROR] container self-check failed.
  docker rm -f ai-pkg-verify >nul 2>&1
  goto :fail
)
docker rm -f ai-pkg-verify >nul 2>&1
rmdir /s /q "%VDIR%" >nul 2>&1
echo [OK] verification passed
call :elapsed

echo.
echo [4/4] Exporting offline package...
if not exist "%IMG_DIR%" mkdir "%IMG_DIR%" >nul 2>&1
del /q "%IMG_DIR%\agent-insight-*.tar" >nul 2>&1
del /q "%IMG_DIR%\agent-insight-*.tar.gz" >nul 2>&1

echo [..] docker save, takes a few minutes and prints nothing. Please wait.
REM Ship the raw "docker save" tar, do NOT gzip it again:
REM 1) layer blobs are already compressed, this tar is only about 0.8GB;
REM 2) tar -czf would wrap it in another archive, and "docker load" then
REM    cannot find manifest.json and fails.
docker save %TAG% -o "%IMG_DIR%\%TAR_FILE%"
if errorlevel 1 (
  echo [ERROR] docker save failed, check free disk space
  goto :fail
)
echo [OK] image saved to %IMG_DIR%\%TAR_FILE%
call :elapsed

for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "(Get-FileHash '%IMG_DIR%\%TAR_FILE%' -Algorithm SHA256).Hash.ToLower()"`) do set "SHA256=%%h"
for /f "usebackq delims=" %%i in (`docker image inspect %TAG% --format "{{.Id}}"`) do set "IMAGE_ID=%%i"
for /f "usebackq delims=" %%n in (`docker run --rm --entrypoint node %TAG% -v`) do set "NODE_VER=%%n"
for /f "usebackq delims=" %%e in (`powershell -NoProfile -Command "[math]::Floor(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - %T0%)/1000)"`) do set "TOTAL=%%e"

powershell -NoProfile -Command "[IO.File]::WriteAllText('%ROOT%SHA256SUMS', '%SHA256%  images/%TAR_FILE%' + [char]10)"

(
  echo build_time=%DATE% %TIME%
  echo source_commit=%COMMIT%
  echo package_version=%VER%
  echo build_id=%BUILD_ID%
  echo image_tag=%TAG%
  echo image_id=%IMAGE_ID%
  echo dockerfile=%DF_NAME%
  echo node_image=%NODE_REF%
  echo node_version=%NODE_VER%
  echo build_elapsed_seconds=%TOTAL%
  echo archive=images/%TAR_FILE%
  echo sha256=%SHA256%
) > "%ROOT%BUILD-INFO.txt"

echo.
echo ============================================================
echo  BUILD OK
echo ------------------------------------------------------------
echo  image  : %TAG%
echo  node   : %NODE_VER%
echo  package: %ROOT%
echo  archive: %IMG_DIR%\%TAR_FILE%
echo  sha256 : %SHA256%
echo  elapsed: %TOTAL%s
echo ============================================================
exit /b 0

:elapsed
for /f "usebackq delims=" %%e in (`powershell -NoProfile -Command "[math]::Floor(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - %T0%)/1000)"`) do echo       elapsed: %%es
goto :eof

:fail
echo.
echo ============================================================
echo  BUILD ABORTED
echo ============================================================
call :hold_window
exit /b 1

:hold_window
REM Keep the window open when a fresh cmd.exe started this script (double-click),
REM so the error above stays readable. Interactive runs skip it.
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause
goto :eof
