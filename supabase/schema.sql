-- ============================================================
-- Content Verify — Supabase schema (open shared sync, no auth)
--
--   • ONE shared dataset that every device reads and writes together,
--     live over realtime. No accounts, no admin, no membership.
--
-- Run in Supabase → SQL Editor → New query. Safe to re-run: the shared
-- data itself is never dropped.
-- ============================================================

-- ---------- remove the old auth / admin / membership machinery ----------
drop table    if exists public.members cascade;
drop table    if exists public.invites cascade;
drop function if exists public.is_admin()               cascade;
drop function if exists public.is_approved()            cascade;
drop function if exists public.apply_membership_rules() cascade;

-- ---------- the one shared dataset ----------
create table if not exists public.shared_state (
  id         text        primary key default 'main',
  state      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Older schemas added updated_by (a FK to auth.users) — no longer used.
alter table public.shared_state drop column if exists updated_by;

alter table public.shared_state enable row level security;

-- Open access: anyone who opens the app can read and write the shared row.
drop policy if exists "shared read"   on public.shared_state;
drop policy if exists "shared insert" on public.shared_state;
drop policy if exists "shared update" on public.shared_state;
drop policy if exists "open all"      on public.shared_state;
create policy "open all" on public.shared_state
  for all using (true) with check (true);

insert into public.shared_state (id, state)
  values ('main', '{}'::jsonb) on conflict (id) do nothing;

-- ---------- table privileges ----------
-- RLS decides WHICH rows you may touch, but Postgres GRANTs decide whether
-- you may touch the table at all. Grant both anon (signed-out visitors) and
-- authenticated, since there is no login.
grant usage on schema public to anon, authenticated;
grant select, insert, update on public.shared_state to anon, authenticated;

-- ---------- realtime ----------
-- REPLICA IDENTITY FULL sends full row contents on every change so open
-- devices repaint immediately. (Ignore "already added" on re-run.)
alter table public.shared_state replica identity full;
do $$
begin
  begin alter publication supabase_realtime add table public.shared_state;
  exception when others then null; end;
end $$;

-- Make the REST/Realtime API pick up this shape immediately.
notify pgrst, 'reload schema';
