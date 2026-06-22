# Moneyboard 오류 테스트 절차

Moneyboard는 로컬 서버에서 네이버 금융 데이터와 선택적으로 KIS Open API 데이터를 조합한다. 테스트는 두 단계로 수행한다.

## 1. 오프라인 코어 테스트

```bat
cd C:\Users\sslee\Desktop\Moneyboard
git pull
npm install
npm test
```

검사 항목:

- 네이버 업종 상세 HTML 파싱
- ETF/ETN/ELW 제외 여부
- 거래대금 컬럼 검증 및 현재가 × 거래량 보정
- 섹터/종목 거래대금 내림차순 정렬
- 검증 실패 탐지 로직
- 섹터 클릭 시 이전 상세 종목 리스트가 남지 않도록 하는 UI 방어 로직
- Vite 빌드 가능 여부

## 2. 로컬 라이브 API 테스트

먼저 서버를 켠다.

```bat
cd C:\Users\sslee\Desktop\Moneyboard
npm run server
```

다른 명령 프롬프트 창에서 실행한다.

```bat
cd C:\Users\sslee\Desktop\Moneyboard
npm run test:live
```

검사 항목:

- `GET /api/provider`
- `GET /api/sectors?force=1`
- `GET /api/validation`
- 상위 5개 섹터의 `GET /api/sectors/:id`
- 선택한 섹터 ID와 상세 응답 ID 일치 여부
- 섹터 거래대금 내림차순 정렬
- 섹터별 종목 거래대금 내림차순 정렬
- 종목코드 6자리 형식
- 현재가/거래량/거래대금 숫자 형식
- KIS 사용 시 `GET /api/kis/quote/005930` 정상 응답

## 3. 엄격 검증 실패 시

`npm run test:live`는 기본적으로 `/api/validation`의 `errorCount`가 0이어야 통과한다.

원천 사이트가 일시적으로 막혔는지, 장중/장외 데이터가 비정상인지 먼저 구분해야 할 때는 아래처럼 완화 모드로 실행할 수 있다.

```bat
set STRICT_VALIDATION=false&& npm run test:live
```

완화 모드는 구조 테스트는 계속 수행하지만 `/api/validation`이 경고를 반환해도 즉시 실패 처리하지 않는다.

## 4. 정상 기준

정상 실행 시 마지막에 다음 형태가 출력된다.

```json
{
  "status": "ok",
  "sectors": 70,
  "topSector": "예시 섹터명",
  "validation": {
    "status": "ok",
    "errorCount": 0
  }
}
```

`validation.status`가 `warning`이거나 `errorCount`가 0이 아니면 데이터 파싱, 정렬, 검증 중 하나가 실패한 것이다.
