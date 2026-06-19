# Moneyboard

국내 주식 업종별 거래대금과 섹터별 종목 흐름을 자동 갱신으로 보여주는 대시보드입니다.

## 실행

```bash
npm install
npm run dev
```

프런트 개발 서버는 `/api` 요청을 Express 백엔드로 프록시합니다. API 서버까지 같이 확인하려면:

```bash
npm run server
```

운영 빌드는 다음 순서로 실행합니다.

```bash
npm run build
npm start
```

## GitHub Pages

GitHub Pages는 정적 호스팅이므로 Express API가 실행되지 않습니다. Pages 배포에서는 `VITE_API_BASE_URL`로 지정한 HTTPS API 서버가 있으면 실시간 스트림을 우선 사용하고, 없으면 빌드 시점에 `public/data` 아래에 생성한 시장 스냅샷을 읽습니다.

```bash
npm run build:pages
```

실시간 Pages 배포 예시:

```bash
VITE_API_BASE_URL=https://your-moneyboard-api.example.com npm run build:pages
```

API 서버는 `npm start`로 실행되는 Express 서버이며, GitHub Pages 도메인의 CORS 요청을 허용합니다.

## 데이터

- 기본 데이터 소스는 네이버 금융 업종별 시세와 업종 상세 페이지입니다.
- 섹터 거래대금은 업종 상세 페이지의 종목별 거래대금(백만원)을 합산해 계산합니다.
- 공식 실시간 주문/체결 API가 필요한 운영 환경에서는 한국투자증권 KIS Developers 같은 인증형 API로 `server.js`의 provider 레이어를 교체할 수 있습니다.
