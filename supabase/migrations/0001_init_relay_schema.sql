-- Pierre Relay — initial schema
-- Every table is RLS-locked to invited members; the relay worker uses the service role.
-- Dashboard auth is invite-only, enforced by a trigger on auth.users.

-- ── membership / auth ─────────────────────────────────────────────────────
create table public.app_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  email text not null unique check (email = lower(email)),
  role text not null default 'viewer' check (role in ('admin','viewer')),
  created_at timestamptz not null default now()
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_members m
    where m.user_id = auth.uid()
       or m.email = lower(coalesce(auth.jwt()->>'email',''))
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_members m
    where (m.user_id = auth.uid() or m.email = lower(coalesce(auth.jwt()->>'email','')))
      and m.role = 'admin'
  );
$$;

-- invite-only signups: block unknown emails, link known ones to their member row
create or replace function public.enforce_invite_only() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.app_members where email = lower(new.email)) then
    raise exception 'signups are invite-only';
  end if;
  update public.app_members set user_id = new.id where email = lower(new.email);
  return new;
end;
$$;

create trigger enforce_invite_only
  before insert on auth.users
  for each row execute function public.enforce_invite_only();

-- ── telegram accounts ─────────────────────────────────────────────────────
create table public.telegram_accounts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('user','bot')),
  label text not null,
  phone text,
  username text,
  tg_id bigint,
  status text not null default 'pending'
    check (status in ('pending','connected','relogin_required','restricted','disabled')),
  is_reader boolean not null default true,
  is_sender boolean not null default true,
  is_alert_sender boolean not null default false,
  max_msgs_per_minute int not null default 20 check (max_msgs_per_minute between 1 and 1800),
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sessions / bot tokens live in a separate policy-less table: service role only.
create table public.account_secrets (
  account_id uuid primary key references public.telegram_accounts(id) on delete cascade,
  secret text not null,
  updated_at timestamptz not null default now()
);

-- ── channels ──────────────────────────────────────────────────────────────
create table public.channels (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('master','receiver','buffer')),
  tg_chat_id bigint,
  title text not null default '',
  username text,
  invite_link text,
  enabled boolean not null default true,
  health text not null default 'unknown'
    check (health in ('ok','unavailable','no_permission','protected','unknown')),
  is_protected boolean not null default false,
  member_count int,
  last_message_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (role, tg_chat_id)
);

create table public.channel_memberships (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.telegram_accounts(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  is_member boolean not null default false,
  is_admin boolean not null default false,
  can_post boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  checked_at timestamptz,
  unique (account_id, channel_id)
);
create index memberships_channel_idx on public.channel_memberships (channel_id);

-- ── routes & rules ────────────────────────────────────────────────────────
-- routes.rules jsonb shape is validated app-side (zod, packages/core):
--   { filters, replacements, linkRemoval, header, footer, signatureStrip }
-- routes.schedule jsonb: { tz, windows: [{dow,start,end}], offWindow: 'hold'|'drop', dropHeldAfterMinutes }
create table public.routes (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references public.channels(id) on delete cascade,
  receiver_id uuid not null references public.channels(id) on delete cascade,
  enabled boolean not null default true,
  mode text not null default 'copy' check (mode in ('copy','forward')),
  silent boolean not null default false,
  sender_account_id uuid references public.telegram_accounts(id) on delete set null,
  use_fanout boolean not null default false,
  delay_seconds int not null default 0 check (delay_seconds between 0 and 86400),
  schedule jsonb,
  paused_until timestamptz,
  sync_edits boolean not null default true,
  sync_deletes boolean not null default true,
  rules jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (master_id, receiver_id),
  check (master_id <> receiver_id)
);
create index routes_master_idx on public.routes (master_id);
create index routes_receiver_idx on public.routes (receiver_id);
create index routes_sender_idx on public.routes (sender_account_id);

create table public.presets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  rules jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ── queue + history (one table: a forward is queued, then becomes history) ─
create table public.forwards (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  master_channel_id uuid not null references public.channels(id) on delete cascade,
  receiver_channel_id uuid not null references public.channels(id) on delete cascade,
  src_message_id bigint not null,
  src_message_ids bigint[],
  album_key text,
  kind text not null default 'post' check (kind in ('post','edit','delete')),
  state text not null default 'queued'
    check (state in ('queued','scheduled','held','sending','done','failed','dropped')),
  drop_reason text,
  deliver_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  sender_account_id uuid references public.telegram_accounts(id) on delete set null,
  dest_message_ids bigint[],
  latency_ms int,
  preview text,
  media_kind text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (route_id, src_message_id, kind)
);
create index forwards_state_deliver_idx on public.forwards (state, deliver_at);
create index forwards_created_idx on public.forwards (created_at desc);
create index forwards_route_idx on public.forwards (route_id, created_at desc);
create index forwards_master_idx on public.forwards (master_channel_id);
create index forwards_receiver_idx on public.forwards (receiver_channel_id);
create index forwards_sender_idx on public.forwards (sender_account_id);
create index forwards_album_idx on public.forwards (album_key) where album_key is not null;

-- ── incidents, alerts, notifications ──────────────────────────────────────
create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'receiver_no_permission','master_unavailable','protected_content',
    'session_revoked','account_restricted','worker_offline','flood_wait',
    'master_silent','route_autopaused')),
  status text not null default 'open' check (status in ('open','resolved')),
  channel_id uuid references public.channels(id) on delete cascade,
  account_id uuid references public.telegram_accounts(id) on delete cascade,
  route_id uuid references public.routes(id) on delete cascade,
  message text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  alerted_at timestamptz
);
create index incidents_open_idx on public.incidents (status, kind);
create index incidents_channel_idx on public.incidents (channel_id);
create index incidents_account_idx on public.incidents (account_id);
create index incidents_route_idx on public.incidents (route_id);

create table public.alert_settings (
  id int primary key default 1 check (id = 1),
  telegram_enabled boolean not null default true,
  telegram_target text,
  email_enabled boolean not null default false,
  email_to text,
  webhook_enabled boolean not null default false,
  webhook_url text,
  quiet_hours jsonb,
  cooldown_minutes int not null default 15 check (cooldown_minutes between 0 and 1440),
  triggers jsonb not null default '{
    "receiver_no_permission": true, "master_unavailable": true,
    "protected_content": true, "session_revoked": true,
    "account_restricted": true, "worker_offline": true,
    "flood_wait": true, "master_silent": false, "route_autopaused": true
  }'::jsonb,
  digest_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.alert_settings (id) values (1);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  title text not null,
  body text not null default '',
  incident_id uuid references public.incidents(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_created_idx on public.notifications (created_at desc);
create index notifications_incident_idx on public.notifications (incident_id);

-- ── ops ───────────────────────────────────────────────────────────────────
create table public.worker_status (
  instance_id text primary key,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  version text,
  accounts_online int not null default 0,
  queue_depth int not null default 0,
  simulate boolean not null default false,
  meta jsonb not null default '{}'::jsonb
);

create table public.app_settings (
  id int primary key default 1 check (id = 1),
  retention_days int not null default 30 check (retention_days between 1 and 365),
  catchup_window_minutes int not null default 15 check (catchup_window_minutes between 0 and 1440),
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null default 'system',
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_created_idx on public.audit_log (created_at desc);

-- ── shared triggers ───────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $do$
declare t text;
begin
  foreach t in array array['telegram_accounts','channels','routes','forwards',
                           'alert_settings','app_settings','account_secrets'] loop
    execute format(
      'create trigger touch_%s before update on public.%I
       for each row execute function public.touch_updated_at()', t, t);
  end loop;
end
$do$;

create or replace function public.write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (
    coalesce(auth.jwt()->>'email', 'service'),
    lower(tg_op),
    tg_table_name,
    case when tg_op = 'DELETE' then old.id::text else new.id::text end,
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_channels
  after insert or update or delete on public.channels
  for each row execute function public.write_audit();
create trigger audit_routes
  after insert or update or delete on public.routes
  for each row execute function public.write_audit();
create trigger audit_accounts
  after insert or delete
    or update of label, status, kind, is_reader, is_sender, is_alert_sender, max_msgs_per_minute
  on public.telegram_accounts
  for each row execute function public.write_audit();
create trigger audit_alert_settings
  after update on public.alert_settings
  for each row execute function public.write_audit();
create trigger audit_app_settings
  after update on public.app_settings
  for each row execute function public.write_audit();

-- ── row level security ────────────────────────────────────────────────────
do $do$
declare t text;
begin
  foreach t in array array['app_members','telegram_accounts','account_secrets','channels',
                           'channel_memberships','routes','presets','forwards','incidents',
                           'alert_settings','notifications','worker_status','app_settings',
                           'audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- config tables: members read, admins write
  foreach t in array array['telegram_accounts','channels','channel_memberships','routes',
                           'presets','alert_settings','app_settings'] loop
    execute format('create policy member_read on public.%I for select using ((select public.is_member()))', t);
    execute format('create policy admin_insert on public.%I for insert with check ((select public.is_admin()))', t);
    execute format('create policy admin_update on public.%I for update using ((select public.is_admin())) with check ((select public.is_admin()))', t);
    execute format('create policy admin_delete on public.%I for delete using ((select public.is_admin()))', t);
  end loop;

  -- telemetry tables: members read, only the worker (service role) writes
  foreach t in array array['forwards','incidents','worker_status','audit_log'] loop
    execute format('create policy member_read on public.%I for select using ((select public.is_member()))', t);
  end loop;
end
$do$;

create policy member_read on public.app_members for select using ((select public.is_member()));
create policy admin_insert on public.app_members for insert with check ((select public.is_admin()));
create policy admin_update on public.app_members for update using ((select public.is_admin())) with check ((select public.is_admin()));
create policy admin_delete on public.app_members for delete using ((select public.is_admin()));

create policy member_read on public.notifications for select using ((select public.is_member()));
create policy member_mark_read on public.notifications for update
  using ((select public.is_member())) with check ((select public.is_member()));

-- account_secrets: deliberately no policies — nothing but the service role can read or write.

-- ── realtime ──────────────────────────────────────────────────────────────
alter publication supabase_realtime add table
  public.forwards, public.incidents, public.notifications, public.worker_status,
  public.channels, public.routes, public.telegram_accounts;

-- ── scheduled jobs ────────────────────────────────────────────────────────
create extension if not exists pg_cron;

select cron.schedule('relay-purge-old-logs', '17 3 * * *', $job$
  delete from public.forwards
  where created_at < now() - make_interval(days => (select retention_days from public.app_settings where id = 1));
  delete from public.audit_log where created_at < now() - interval '90 days';
  delete from public.notifications where created_at < now() - interval '60 days';
$job$);

-- Watchdog lives in the database so it still fires when the worker itself is down.
select cron.schedule('relay-worker-watchdog', '* * * * *', $job$
  insert into public.incidents (kind, status, message)
  select 'worker_offline', 'open', 'No worker heartbeat for over 2 minutes'
  where exists (select 1 from public.worker_status)
    and not exists (select 1 from public.worker_status where heartbeat_at > now() - interval '2 minutes')
    and not exists (select 1 from public.incidents where kind = 'worker_offline' and status = 'open');

  insert into public.notifications (kind, title, body, incident_id)
  select 'worker_offline', 'Relay offline',
         'The relay worker has not sent a heartbeat for over 2 minutes.', i.id
  from public.incidents i
  where i.kind = 'worker_offline' and i.status = 'open' and i.alerted_at is null;

  update public.incidents set alerted_at = now()
  where kind = 'worker_offline' and status = 'open' and alerted_at is null;

  update public.incidents set status = 'resolved', resolved_at = now()
  where kind = 'worker_offline' and status = 'open'
    and exists (select 1 from public.worker_status where heartbeat_at > now() - interval '2 minutes');
$job$);

-- ── seed ──────────────────────────────────────────────────────────────────
insert into public.app_members (email, role)
values ('joshivilol1011@gmail.com', 'admin')
on conflict (email) do update set role = 'admin';
