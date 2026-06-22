# Moneyboard 로컬 실행 안내

1. 프로젝트 폴더에서 최신 코드를 받습니다.

```text
cd C:\Users\sslee\Desktop\Moneyboard
git pull
npm install
```

2. `env.example` 파일을 `.env` 이름으로 복사한 뒤 한국투자증권 Open API 값을 입력합니다.

필수 값은 `KIS_ENABLED`, `KIS_ENV`, `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_MARKET_DIV_CODE`입니다.

3. 로컬 서버를 실행합니다.

```text
npm run server
```

4. 브라우저에서 `http://localhost:4173`을 엽니다.

5. 연결 확인 주소는 `/api/provider`, `/api/kis/status`, `/api/kis/quote/005930`, `/api/validation`입니다.

앞으로 업데이트 후 실행할 때는 `git pull`, `npm install`, `npm run server` 순서로 실행하면 됩니다.
