create table if not exists public.quant_trades (
  id bigint generated always as identity primary key,
  side text not null check (side in ('buy', 'sell')),
  price numeric(20, 2) not null,
  amount numeric(20, 2) not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_quant_trades_created_at on public.quant_trades (created_at desc);

create table if not exists public.quant_ai_logs (
  id bigint generated always as identity primary key,
  decision text not null check (decision in ('BUY', 'SELL', 'HOLD')),
  sentiment_score integer not null check (sentiment_score between 0 and 100),
  analysis_reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_quant_ai_logs_created_at on public.quant_ai_logs (created_at desc);
