# CoinPJ

CoinPJ is an automated BTC trading bot for KRW markets on Upbit.
It combines news sentiment, OHLCV chart analysis, technical signals, and risk-managed execution.

## Features
- News collection and AI-based market interpretation
- Technical signal engine (EMA, RSI, ATR, breakout/breakdown)
- Volatility-based position sizing
- Trailing stop and partial take-profit
- Supabase trade/audit logging
- Safe execution controls:
  - `DRY_RUN` simulation mode
  - `CONFIRM_REAL_TRADING` real-trade confirmation gate
- Cron-based scheduler with overlap protection

## Project Structure
- `main.js`: scheduler + strategy execution flow
- `logic.js`: news/chart fetch + technical/AI decision logic
- `order.js`: Upbit authenticated order/account APIs
- `db.js`: Supabase persistence helpers
- `supabase/migrations/`: schema migrations

## Prerequisites
- Node.js 18+
- Upbit API keys
- Gemini API key
- Tavily API key
- Supabase project (URL + Service Role Key)

## Environment Variables
Create `.env` with required keys:

- `UPBIT_ACCESS_KEY`
- `UPBIT_SECRET_KEY`
- `GEMINI_API_KEY`
- `TAVILY_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Strategy/runtime controls (examples):

- `DRY_RUN=true`
- `CONFIRM_REAL_TRADING=false`
- `BOT_CRON=*/30 * * * *`
- `RUN_ONCE=false`
- `BUY_CONFIDENCE_THRESHOLD=75`
- `SELL_CONFIDENCE_THRESHOLD=70`
- `TAKE_PROFIT_PCT=1.8`
- `TAKE_PROFIT_SELL_RATIO=0.3`

## Install
```bash
npm install
```

## Supabase Setup
```bash
npm run supabase:login
npm run supabase:link
npm run db:push
```

## Run
Single test cycle:
```bash
npm run start:once
```

Scheduled mode:
```bash
npm start
```

## Safety Notes
- Keep `DRY_RUN=true` until logs and behavior are fully validated.
- Set `DRY_RUN=false` only with `CONFIRM_REAL_TRADING=true`.
- This software does not guarantee profits. Always manage risk.

## License
Personal project.
