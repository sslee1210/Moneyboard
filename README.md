# Moneyboard

국내 주식 업종별 거래대금, 섹터별 종목, 일간·주간·월간 거래량을 한 화면에서 확인하는 대시보드입니다.

## 바로가기

[Moneyboard GitHub Pages](https://sslee1210.github.io/Moneyboard/)

## GitHub Pages

공개 사이트는 아래 링크 하나로 열 수 있습니다.

[https://sslee1210.github.io/Moneyboard/](https://sslee1210.github.io/Moneyboard/)

GitHub Pages는 정적 호스팅이라 브라우저에서 네이버 금융 데이터를 직접 실시간 호출하기 어렵습니다. 대신 GitHub Actions가 평일 장중에 주기적으로 데이터를 다시 생성해 `gh-pages`에 배포하고, 화면은 배포된 `data/*.json`을 자동으로 다시 읽습니다.

- 장중 자동 갱신: 평일 09:00-16:00 KST 구간 약 5분 간격
- 장 마감 스냅샷: 평일 17:05 KST 1회
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
