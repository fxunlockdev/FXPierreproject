-- Review hardening: fixes from the full code / security / database review pass.
--
-- 1. Auth: close the invite-claim race (link only confirmed users, require the
--    user_id linkage for membership — a JWT email claim alone no longer counts).
--    NOTE: production must also enable "Confirm email" in Supabase Auth settings;
--    without it Supabase auto-confirms signups and the trigger guard is moot.
-- 2. Queue: partial index for the 800ms claim poll (the old (state, deliver_at)
--    btree degraded as done/failed history accumulated).
-- 3. History: channel/route deletes no longer cascade-wipe the forward log or
--    incident history — FKs become SET NULL.
-- 4. Missing indexes for the Activity filters, edit/delete sync lookup, and
--    incident feed; drop two redundant indexes.
-- 5. forwards bloat control: aggressive autovacuum + fillfactor headroom.
-- 6. notifications: members may only flip read_at (was: any column).
-- 7. Retention job: bounded deletes, plus worker_status and resolved-incident
--    purges that were missing.
-- 8. account_secrets: explicit REVOKE as defense-in-depth alongside RLS.

-- ── 1. auth hardening ─────────────────────────────────────────────────────
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_members m where m.user_id = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_members m
    where m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

-- Link the member row only once the auth user is CONFIRMED, and never steal a
-- linkage that already exists. Fires on insert (auto-confirm setups) and on
-- the confirmation update (production, with "Confirm email" enabled).
create or replace function public.link_member_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null then
    update public.app_members
    set user_id = new.id
    where email = lower(new.email) and user_id is null;
  end if;
  return new;
end;
$$;

drop trigger if exists link_member_on_signup on auth.users;
create trigger link_member_on_signup
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.link_member_on_signup();

-- ── 2. claim-path index ───────────────────────────────────────────────────
drop index if exists public.forwards_state_deliver_idx;
create index forwards_active_deliver_idx on public.forwards (deliver_at)
  where state in ('queued','scheduled','held','sending');

-- ── 3. history-preserving foreign keys ────────────────────────────────────
alter table public.forwards
  alter column route_id drop not null,
  alter column master_channel_id drop not null,
  alter column receiver_channel_id drop not null;

alter table public.forwards drop constraint forwards_route_id_fkey;
alter table public.forwards add constraint forwards_route_id_fkey
  foreign key (route_id) references public.routes(id) on delete set null;
alter table public.forwards drop constraint forwards_master_channel_id_fkey;
alter table public.forwards add constraint forwards_master_channel_id_fkey
  foreign key (master_channel_id) references public.channels(id) on delete set null;
alter table public.forwards drop constraint forwards_receiver_channel_id_fkey;
alter table public.forwards add constraint forwards_receiver_channel_id_fkey
  foreign key (receiver_channel_id) references public.channels(id) on delete set null;

alter table public.incidents drop constraint incidents_channel_id_fkey;
alter table public.incidents add constraint incidents_channel_id_fkey
  foreign key (channel_id) references public.channels(id) on delete set null;
alter table public.incidents drop constraint incidents_account_id_fkey;
alter table public.incidents add constraint incidents_account_id_fkey
  foreign key (account_id) references public.telegram_accounts(id) on delete set null;
alter table public.incidents drop constraint incidents_route_id_fkey;
alter table public.incidents add constraint incidents_route_id_fkey
  foreign key (route_id) references public.routes(id) on delete set null;

-- ── 4. indexes ────────────────────────────────────────────────────────────
create index forwards_state_created_idx on public.forwards (state, created_at desc);
create index forwards_src_ids_gin on public.forwards using gin (src_message_ids);
create index incidents_last_seen_idx on public.incidents (last_seen desc);
drop index if exists public.routes_master_idx;   -- unique(master_id, receiver_id) already leads with master_id

-- ── 5. forwards bloat control ─────────────────────────────────────────────
alter table public.forwards set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02,
  fillfactor = 85
);

-- ── 6. notifications: members may only mark as read ───────────────────────
create or replace function public.notifications_readonly_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The worker (service role, bypasses RLS but not triggers) only inserts;
  -- dashboard members may only flip read_at.
  if new.id         is distinct from old.id
     or new.kind        is distinct from old.kind
     or new.title       is distinct from old.title
     or new.body        is distinct from old.body
     or new.incident_id is distinct from old.incident_id
     or new.created_at  is distinct from old.created_at then
    raise exception 'notifications are immutable except read_at';
  end if;
  return new;
end;
$$;

create trigger notifications_readonly_guard
  before update on public.notifications
  for each row execute function public.notifications_readonly_guard();

-- ── 7. retention job (bounded, wider coverage) ────────────────────────────
select cron.unschedule('relay-purge-old-logs');
select cron.schedule('relay-purge-old-logs', '17 3 * * *', $job$
  delete from public.forwards where id in (
    select id from public.forwards
    where created_at < now() - make_interval(days => (select retention_days from public.app_settings where id = 1))
    limit 50000
  );
  delete from public.audit_log where created_at < now() - interval '90 days';
  delete from public.notifications where created_at < now() - interval '60 days';
  delete from public.worker_status where heartbeat_at < now() - interval '7 days';
  delete from public.incidents
  where status = 'resolved' and resolved_at < now() - interval '90 days';
$job$);

-- ── 8. secrets defense in depth ───────────────────────────────────────────
revoke all on public.account_secrets from anon, authenticated;
