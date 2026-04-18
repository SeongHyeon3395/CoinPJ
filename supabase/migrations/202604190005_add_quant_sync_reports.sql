create table if not exists public.quant_sync_reports (
  id bigint generated always as identity primary key,
  report_date date not null,
  is_simulated boolean not null default false,
  checked_markets integer not null default 0,
  mismatches integer not null default 0,
  recovered_count integer not null default 0,
  closed_count integer not null default 0,
  qty_adjusted_count integer not null default 0,
  details text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_date, is_simulated)
);

create index if not exists idx_quant_sync_reports_date
  on public.quant_sync_reports (report_date desc, is_simulated);

create or replace function public.set_quant_sync_reports_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_quant_sync_reports_updated_at on public.quant_sync_reports;
create trigger trg_quant_sync_reports_updated_at
before update on public.quant_sync_reports
for each row execute function public.set_quant_sync_reports_updated_at();
