alter table public.quant_trades
  add column if not exists is_simulated boolean not null default false;

alter table public.quant_ai_logs
  add column if not exists is_simulated boolean not null default false;

alter table public.quant_positions
  add column if not exists is_simulated boolean not null default false;

create index if not exists idx_quant_trades_sim_created
  on public.quant_trades (is_simulated, created_at desc);

create index if not exists idx_quant_ai_logs_sim_created
  on public.quant_ai_logs (is_simulated, created_at desc);

create index if not exists idx_quant_positions_sim_status
  on public.quant_positions (is_simulated, status, opened_at desc);
