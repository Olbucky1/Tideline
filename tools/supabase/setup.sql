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
