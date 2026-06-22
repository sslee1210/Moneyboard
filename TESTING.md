# Moneyboard 오류 테스트 절차

Moneyboard는 로컬 서버에서 네이버 금융 데이터와 선택적으로 KIS Open API 데이터를 조합한다. 테스트는 세 가지 방식으로 수행할 수 있다.

## 0. Git Bash 경로 주의

Git Bash에서는 Windows 경로를 그대로 쓰면 안 된다.

잘못된 예:

```bash
cd C:\Users\sslee\Desktop\Moneyboard
```

Git Bash에서는 아래처럼 입력한다.

```bash
cd /c/Users/sslee/Desktop/Moneyboard
```

이미 프롬프트가 `~/Desktop/Moneyboard (main)`이면 현재 폴더가 Moneyboard이므로 `cd`를 다시 할 필요가 없다.

## 1. 오프라인 코어 테스트

```bash
cd /c/Users/sslee/Desktop/Moneyboard
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

## 2. 원샷 로컬 라이브 테스트

서버 실행과 라이브 테스트를 한 번에 처리하려면 아래 명령을 사용한다.

```bash
cd /c/Users/sslee/Desktop/Moneyboard
git pull
npm install
npm run test:local
```

`test:local`은 내부적으로 서버를 실행하고, `/api/provider`가 응답할 때까지 기다린 뒤 `test:live`를 수행하고 서버를 종료한다.

## 3. 수동 로컬 라이브 API 테스트

서버를 직접 켜서 화면도 같이 확인하려면 먼저 서버를 켠다.

```bash
cd /c/Users/sslee/Desktop/Moneyboard
npm run server
```

다른 명령 프롬프트 또는 Git Bash 창에서 실행한다.

```bash
cd /c/Users/sslee/Desktop/Moneyboard
npm run test:live
```

검사 항목:

- `GET /api/provider`
- `GET /api/sectors`
- `GET /api/validation`
- 상위 5개 섹터의 `GET /api/sectors/:id`
- 선택한 섹터 ID와 상세 응답 ID 일치 여부
- 섹터 거래대금 내림차순 정렬
- 섹터별 종목 거래대금 내림차순 정렬
- 종목코드 6자리 형식
- 현재가/거래량/거래대금 숫자 형식
- KIS 사용 시 `GET /api/kis/quote/005930` 정상 응답

강제로 새 데이터를 다시 긁어 테스트하려면 아래처럼 실행한다.

```bash
MONEYBOARD_FORCE_LIVE=true npm run test:live
```

서버 첫 스냅샷이 오래 걸릴 때는 timeout을 늘릴 수 있다.

```bash
MONEYBOARD_SNAPSHOT_TIMEOUT_MS=600000 npm run test:live
```

## 4. 엄격 검증 실패 시

`npm run test:live`와 `npm run test:local`은 기본적으로 `/api/validation`의 `errorCount`가 0이어야 통과한다.

원천 사이트가 일시적으로 막혔는지, 장중/장외 데이터가 비정상인지 먼저 구분해야 할 때는 아래처럼 완화 모드로 실행할 수 있다.

```bash
STRICT_VALIDATION=false npm run test:live
```

완화 모드는 구조 테스트는 계속 수행하지만 `/api/validation`이 경고를 반환해도 즉시 실패 처리하지 않는다.

## 5. 정상 기준

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
