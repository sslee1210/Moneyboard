@echo off
chcp 65001 >nul
setlocal

title Moneyboard 실행
cd /d "%~dp0"

echo.
echo ========================================
echo  Moneyboard 실행
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo 처음설치.bat 안내에 따라 Node.js 18 이상 LTS를 설치하세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [안내] node_modules 폴더가 없습니다.
  echo 먼저 처음설치.bat을 실행해 주세요.
  echo.
  pause
  exit /b 1
)

echo 서버를 시작합니다.
echo 브라우저 주소: http://localhost:4173
echo 종료하려면 이 창에서 Ctrl + C를 누르세요.
echo.

call npm run server

echo.
echo 서버가 종료되었습니다.
echo 오류가 있었다면 위 내용을 복사해서 전달해 주세요.
echo.
pause
