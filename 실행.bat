@echo off
chcp 65001 > nul
setlocal
title Moneyboard 실행

cd /d "%~dp0"

echo.
echo ========================================
echo   Moneyboard 실행 프로그램
echo ========================================
echo.

if not exist "package.json" (
  echo [오류] 이 파일은 Moneyboard 폴더 안에서 실행해야 합니다.
  echo 실행.bat 파일을 Moneyboard-main 또는 Moneyboard 폴더 안에 넣어주세요.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo.
  echo 아래 사이트에서 Node.js LTS 버전을 설치한 뒤 다시 실행하세요.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [오류] npm을 찾을 수 없습니다.
  echo Node.js LTS를 다시 설치한 뒤 실행하세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [최초 실행] 필요한 패키지를 설치합니다.
  echo 이 작업은 처음 한 번만 오래 걸릴 수 있습니다.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [오류] npm install 실패
    echo 인터넷 연결 또는 Node.js 설치 상태를 확인하세요.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo [실행] Moneyboard 서버를 시작합니다.
echo 브라우저 주소: http://localhost:4173/
echo.

start "" cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:4173/"
call npm start

echo.
echo Moneyboard가 종료되었습니다.
echo.
pause
