alter table public.quant_positions
  add column if not exists take_profit_done boolean not null default false;

create index if not exists idx_quant_positions_tp_done
  on public.quant_positions (status, is_simulated, take_profit_done, opened_at desc);
