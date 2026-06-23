@echo off
chcp 65001 >nul
setlocal EnableExtensions

title Moneyboard 네이버-야후 버전 실행기

echo.
echo ============================================================
echo  Moneyboard 네이버-야후 버전 실행기
echo ============================================================
echo.

REM Always move to the folder where this BAT file exists.
REM This prevents npm from running in C:\Windows\System32.
cd /d "%~dp0"

echo [현재 위치]
cd
echo.

if not exist "package.json" (
  echo [오류] package.json을 찾을 수 없습니다.
  echo 이 파일은 반드시 Moneyboard 폴더 안에서 실행해야 합니다.
  echo 현재 위치가 C:\Windows\System32 로 나오면 압축 푼 폴더 밖에서 실행된 것입니다.
  echo.
  echo 해결: GitHub ZIP 압축을 푼 폴더 안의 부장님_실행.bat을 직접 더블클릭하세요.
  echo.
  pause
  exit /b 1
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo Node.js LTS 설치 페이지를 엽니다. 설치 후 다시 실행하세요.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [오류] npm.cmd를 찾을 수 없습니다. Node.js LTS를 다시 설치하세요.
  pause
  exit /b 1
)

echo [1/4] Node / npm 확인
node.exe -v
call npm.cmd -v
echo.

echo [2/4] 패키지 설치
call npm.cmd install
if errorlevel 1 (
  echo.
  echo [오류] npm install 실패
  pause
  exit /b 1
)

echo.
echo [3/4] 프론트 빌드 생성
call npm.cmd run build
if errorlevel 1 (
  echo.
  echo [오류] npm run build 실패
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo.
  echo [오류] build 후에도 dist\index.html 파일이 없습니다.
  pause
  exit /b 1
)

echo.
echo [4/4] 서버 실행
echo 브라우저를 엽니다: http://localhost:4173
start "" "http://localhost:4173"
node server.js

echo.
echo 서버가 종료되었습니다.
pause
