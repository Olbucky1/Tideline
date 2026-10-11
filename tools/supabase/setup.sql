-- Tideline account sync: one row per user holding their app data. Run once in Supabase → SQL Editor.
create table if not exists public.tideline_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.tideline_data enable row level security;
create policy "read own" on public.tideline_data for select using (auth.uid() = user_id);
create policy "insert own" on public.tideline_data for insert with check (auth.uid() = user_id);
create policy "update own" on public.tideline_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own" on public.tideline_data for delete using (auth.uid() = user_id);

-- Great Loop reports shared between Tideline users (lock delays, shoaling, marinas, fuel prices). Any signed-in user can read;
-- you can only add, change or delete your own. Reports older than a year are ignored by the app.
create table if not exists public.loop_reports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  boat text,
  kind text not null check (kind in ('lock','shoal','bridge','marina','fuel','anchor','hazard','tip')),
  lat double precision not null,
  lon double precision not null,
  body text not null check (char_length(body) between 3 and 600),
  created_at timestamptz not null default now()
);
create index if not exists loop_reports_time on public.loop_reports (created_at desc);
alter table public.loop_reports enable row level security;
create policy "loop read" on public.loop_reports for select using (auth.role() = 'authenticated');
create policy "loop add own" on public.loop_reports for insert with check (auth.uid() = user_id);
create policy "loop change own" on public.loop_reports for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "loop delete own" on public.loop_reports for delete using (auth.uid() = user_id);
