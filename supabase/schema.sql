-- ============================================================
-- Content Verify — Supabase schema
--   • Email + password auth (public sign-up disabled in the dashboard)
--   • Admin (yoyotsai2024@gmail.com) manages users via the admin-users
--     Edge Function (service-role key stays server-side)
--   • ONE shared dataset with realtime; active members edit it together
--
-- Run in Supabase → SQL Editor → New query. Safe to re-run: neither the
-- shared data nor the member list is ever dropped.
-- ============================================================

-- ---------- admin check (from the signed-in JWT email) ----------
create or replace function public.is_admin()
returns boolean language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
       = lower('yoyotsai2024@gmail.com');
$$;

-- ---------- remove the old magic-link / invite machinery ----------
drop trigger if exists members_apply_rules on public.members;
drop function if exists public.apply_membership_rules();
drop table if exists public.invites;

-- ---------- members: a mirror of the users the admin manages ----------
create table if not exists public.members (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  email      text        not null,
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);

-- Migrate the old { approved } shape to { active } in place, so re-running
-- this file never costs you your member list.
alter table public.members add column if not exists active boolean not null default true;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'members' and column_name = 'approved'
  ) then
    update public.members set active = approved;
    alter table public.members drop column approved;
  end if;
end $$;

alter table public.members enable row level security;

-- Reads only: admin sees everyone; a user sees only their own row.
-- There are NO client write policies — every write goes through the
-- Edge Function (service role) or the FK cascade on user deletion.
drop policy if exists "member read" on public.members;
create policy "member read" on public.members
  for select using (auth.uid() = user_id or public.is_admin());

-- ---------- is the caller an active member? ----------
create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members m
    where m.user_id = auth.uid() and m.active
  );
$$;

-- ---------- the shared dataset (UNCHANGED — data preserved) ----------
create table if not exists public.shared_state (
  id         text        primary key default 'main',
  state      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users (id)
);
alter table public.shared_state enable row level security;

-- Only the admin or an active member may read/write the shared data.
drop policy if exists "shared read"   on public.shared_state;
create policy "shared read" on public.shared_state
  for select using (public.is_admin() or public.is_approved());

drop policy if exists "shared insert" on public.shared_state;
create policy "shared insert" on public.shared_state
  for insert with check (public.is_admin() or public.is_approved());

drop policy if exists "shared update" on public.shared_state;
create policy "shared update" on public.shared_state
  for update using (public.is_admin() or public.is_approved())
             with check (public.is_admin() or public.is_approved());

insert into public.shared_state (id, state)
  values ('main', '{}'::jsonb) on conflict (id) do nothing;

-- ---------- table privileges ----------
-- RLS decides WHICH rows you may touch, but Postgres GRANTs decide whether
-- you may touch the table at all. Without these, a signed-in member gets
-- "permission denied for table shared_state" and sync silently dies — the
-- policies above never even get a chance to run.
--
-- Only `authenticated` is granted; `anon` gets nothing, so a signed-out
-- visitor cannot read the data even before RLS is consulted.
grant usage on schema public to authenticated;
grant select, insert, update on public.shared_state to authenticated;
grant select                 on public.members      to authenticated;
grant execute on function public.is_admin()    to authenticated;
grant execute on function public.is_approved() to authenticated;

revoke all on public.shared_state from anon;
revoke all on public.members      from anon;

-- ---------- realtime (ignore "already added" on re-run) ----------
-- REPLICA IDENTITY FULL makes the row contents available on UPDATE/DELETE
-- events, which is what lets a "deactivate" or "delete" reach the member's
-- open tab and drop them to the No-access screen immediately.
alter table public.shared_state replica identity full;
alter table public.members      replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table public.shared_state;
  exception when others then null; end;
  begin alter publication supabase_realtime add table public.members;
  exception when others then null; end;
end $$;
