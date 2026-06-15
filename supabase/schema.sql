create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  name text not null,
  display_name text,
  memo text default '',
  breakout_pct numeric not null default 0.8,
  pullback_pct numeric not null default 1.5,
  preferred_score numeric not null default 68,
  max_risk_alert_score numeric not null default 60,
  active boolean not null default true,
  last_signal text,
  last_signal_at timestamptz,
  last_severity text default 'idle',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists watchlists_user_code_key on public.watchlists(user_id, code);

create table if not exists public.notification_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('feishu', 'wecom')),
  webhook_url text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists notification_channels_user_provider_key
  on public.notification_channels(user_id, provider);

create table if not exists public.alert_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  watchlist_id uuid references public.watchlists(id) on delete set null,
  code text not null,
  name text not null,
  signal text not null,
  severity text not null,
  reason text not null,
  action text not null,
  stance text,
  total_score numeric,
  sent_providers jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.watchlists enable row level security;
alter table public.notification_channels enable row level security;
alter table public.alert_logs enable row level security;

create policy "watchlists owner select"
  on public.watchlists for select
  using (auth.uid() = user_id);

create policy "watchlists owner insert"
  on public.watchlists for insert
  with check (auth.uid() = user_id);

create policy "watchlists owner update"
  on public.watchlists for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "watchlists owner delete"
  on public.watchlists for delete
  using (auth.uid() = user_id);

create policy "channels owner select"
  on public.notification_channels for select
  using (auth.uid() = user_id);

create policy "channels owner insert"
  on public.notification_channels for insert
  with check (auth.uid() = user_id);

create policy "channels owner update"
  on public.notification_channels for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "channels owner delete"
  on public.notification_channels for delete
  using (auth.uid() = user_id);

create policy "alert logs owner select"
  on public.alert_logs for select
  using (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists watchlists_set_updated_at on public.watchlists;
create trigger watchlists_set_updated_at
before update on public.watchlists
for each row execute procedure public.set_updated_at();

drop trigger if exists notification_channels_set_updated_at on public.notification_channels;
create trigger notification_channels_set_updated_at
before update on public.notification_channels
for each row execute procedure public.set_updated_at();
