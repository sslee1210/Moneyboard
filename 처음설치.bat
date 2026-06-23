@echo off
chcp 65001 >nul
setlocal

title Moneyboard 처음 설치
cd /d "%~dp0"

echo.
echo ========================================
echo  Moneyboard 처음 설치
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo Node.js 18 이상 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [오류] npm을 찾을 수 없습니다.
  echo Node.js를 다시 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

echo [1/3] Node 버전 확인
node -v
npm -v
echo.

echo [2/3] 패키지 설치 중...
call npm install
if errorlevel 1 (
  echo.
  echo [오류] npm install 실패
  echo 인터넷 연결 또는 보안 프로그램 차단 여부를 확인하세요.
  echo.
  pause
  exit /b 1
)

echo.
echo [3/3] 프론트엔드 빌드 중...
call npm run build
if errorlevel 1 (
  echo.
  echo [오류] 빌드 실패
  echo 위 오류 내용을 복사해서 전달해 주세요.
  echo.
  pause
  exit /b 1
)

echo.
echo ========================================
echo  설치 완료
echo ========================================
echo 이제 실행.bat을 더블클릭하면 됩니다.
echo.
pause
