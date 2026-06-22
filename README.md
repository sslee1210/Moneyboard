# Moneyboard

국내 주식 업종별 거래대금, 섹터별 종목, 일간·주간·월간 거래량을 한 화면에서 확인하는 대시보드입니다.

## 바로가기

[Moneyboard GitHub Pages](https://sslee1210.github.io/Moneyboard/)

## GitHub Pages

공개 사이트는 아래 링크 하나로 열 수 있습니다.

[https://sslee1210.github.io/Moneyboard/](https://sslee1210.github.io/Moneyboard/)

GitHub Pages는 정적 호스팅이라 자체 서버를 실행할 수 없습니다. 그래서 공개 화면은 브라우저에서 네이버 금융 리더 경로를 우선 호출해 실시간 수집을 시도하고, 수집이 끝나는 즉시 다음 수집을 시작합니다. 라이브 수집이 막히거나 지연될 때만 배포된 `data/*.json` 스냅샷을 백업으로 보여줍니다.

- 화면 갱신: 라이브 수집 성공 시 대기 없이 다음 수집 시작
- 백업 스냅샷: GitHub Actions가 평일 장중 주기적으로 생성
- 수동 갱신: GitHub Actions의 `Refresh Moneyboard Pages` 워크플로 실행

## 로컬 실행

```bash
npm install
npm run dev
```

개발 중 Express API까지 같이 확인하려면:

```bash
npm run server
```

운영용 Pages 빌드는 데이터 스냅샷을 먼저 생성합니다.

```bash
npm run build:pages
```

## 데이터

- 기본 데이터는 네이버 금융 업종별 시세와 업종 상세 페이지를 사용합니다.
- 업종 거래대금은 업종 상세 페이지의 종목별 거래대금을 합산해 계산합니다.
- 섹터 상세의 일간·주간·월간 거래량은 상위 종목의 최근 거래량 데이터를 합산해 표시합니다.
