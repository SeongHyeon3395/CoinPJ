create table if not exists public.quant_positions (
  id bigint generated always as identity primary key,
  market text not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  entry_price numeric(20, 2) not null,
  quantity_btc numeric(30, 12) not null,
  invested_krw numeric(20, 2) not null,
  highest_price numeric(20, 2) not null,
  trailing_stop_price numeric(20, 2) not null,
  atr_at_entry numeric(20, 2),
  entry_reason text,
  exit_price numeric(20, 2),
  exit_reason text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists idx_quant_positions_market_status on public.quant_positions (market, status);
create index if not exists idx_quant_positions_opened_at on public.quant_positions (opened_at desc);
