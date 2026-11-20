create table if not exists public.planner_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.planner_data enable row level security;
grant select, insert, update on public.planner_data to authenticated;

create or replace function public.set_planner_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists planner_data_updated_at on public.planner_data;
create trigger planner_data_updated_at
  before update on public.planner_data
  for each row execute function public.set_planner_updated_at();

drop policy if exists "Users can read their planner data" on public.planner_data;
create policy "Users can read their planner data"
  on public.planner_data for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their planner data" on public.planner_data;
create policy "Users can create their planner data"
  on public.planner_data for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their planner data" on public.planner_data;
create policy "Users can update their planner data"
  on public.planner_data for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.google_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  encrypted_refresh_token text not null,
  calendar_id text,
  time_zone text not null default 'UTC',
  last_sync_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.google_connections enable row level security;
revoke all on public.google_connections from anon, authenticated;
grant all on public.google_connections to service_role;

drop trigger if exists google_connections_updated_at on public.google_connections;
create trigger google_connections_updated_at
  before update on public.google_connections
  for each row execute function public.set_planner_updated_at();
