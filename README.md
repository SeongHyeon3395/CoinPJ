# CoinPJ

CoinPJ는 업비트 KRW-BTC 마켓을 대상으로 동작하는 자동 매매 봇입니다.
뉴스 심리, OHLCV 차트 데이터, 기술적 지표를 결합하고 리스크 관리 규칙(포지션 사이징, 트레일링 스탑, 부분 익절)을 적용합니다.

## 주요 기능
- 뉴스 수집 및 AI 기반 시장 해석
- 기술 신호 계산: EMA, RSI, ATR, 돌파/이탈
- 변동성(ATR) 기반 주문 금액 계산
- 트레일링 스탑 + 부분 익절
- Supabase 거래/로그 저장
- 안전 실행 장치
  - DRY_RUN 모의투자 모드
  - CONFIRM_REAL_TRADING 실거래 이중 확인
- 크론 스케줄러 기반 자동 실행 + 중복 실행 방지

## 프로젝트 구조
- `main.js`: 스케줄러 및 전략 실행 흐름
- `logic.js`: 뉴스/차트 수집, 기술 분석, AI 판단
- `order.js`: 업비트 인증 API(주문/계좌/잔고)
- `db.js`: Supabase 저장/조회 모듈
- `supabase/migrations/`: DB 마이그레이션 SQL

## 사전 준비
- Node.js 18 이상
- 업비트 API 키
- Gemini API 키
- Tavily API 키
- Supabase 프로젝트(URL, Service Role Key)

## 환경변수 설정
루트 경로에 `.env` 파일을 만들고 아래 값을 설정하세요.

필수 키
- `UPBIT_ACCESS_KEY`
- `UPBIT_SECRET_KEY`
- `GEMINI_API_KEY`
- `TAVILY_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

전략/실행 제어 예시
- `DRY_RUN=true`
- `CONFIRM_REAL_TRADING=false`
- `BOT_CRON=*/30 * * * *`
- `RUN_ONCE=false`
- `BUY_CONFIDENCE_THRESHOLD=75`
- `SELL_CONFIDENCE_THRESHOLD=70`
- `TAKE_PROFIT_PCT=1.8`
- `TAKE_PROFIT_SELL_RATIO=0.3`

## 설치
```bash
npm install
```

## Supabase 설정
```bash
npm run supabase:login
npm run supabase:link
npm run db:push
```

## 실행 방법
1회 테스트 실행
```bash
npm run start:once
```

상시 스케줄 실행
```bash
npm start
```

## 실거래 전환 체크리스트
1. 충분한 기간 DRY_RUN으로 로그 검증
2. `DRY_RUN=false` 설정
3. `CONFIRM_REAL_TRADING=true` 설정
4. 소액으로 시작해 주문/청산 동작 확인

## 주의사항
- 이 소프트웨어는 수익을 보장하지 않습니다.
- 시장 급변 및 슬리피지로 손실이 발생할 수 있습니다.
- API 키/시크릿은 절대 저장소에 커밋하지 마세요.

## 라이선스
개인 프로젝트용입니다.
