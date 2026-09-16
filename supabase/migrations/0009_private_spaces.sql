-- Private spaces (multi-tenant).
--
-- Every client works in their own space: their own bots, channels, routes,
-- topics, activity, alerts and settings. People see only spaces they belong
-- to (row-level security), and database triggers make cross-space
-- references impossible (a route in space A can never use space B's channels
-- or bots). Anyone can sign up and gets a blank space; an invite code joins
-- an existing space instead. Platform admins can list spaces, disable them
-- and close sign-ups — but never read what's inside a space.

-- ── 1. spaces, members, invites, platform ──────────────────────────────────
create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  created_by uuid references auth.users(id) on delete set null,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.space_members (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','viewer')),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index space_members_user_idx on public.space_members (user_id);

create table public.space_invites (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  code_hash text not null unique,
  role text not null check (role in ('admin','viewer')),
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index space_invites_space_idx on public.space_invites (space_id);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.platform_settings (
  id int primary key default 1 check (id = 1),
  signups_open boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (1);

-- ── 2. every tenant table gets a space ────────────────────────────────────
alter table public.telegram_accounts   add column space_id uuid;
alter table public.channels            add column space_id uuid;
alter table public.channel_memberships add column space_id uuid;
alter table public.routes              add column space_id uuid;
alter table public.presets             add column space_id uuid;
alter table public.forwards            add column space_id uuid;
alter table public.incidents           add column space_id uuid;
alter table public.notifications       add column space_id uuid;
alter table public.audit_log           add column space_id uuid;
alter table public.discovered_chats    add column space_id uuid;
alter table public.forum_topics        add column space_id uuid;
alter table public.alert_settings      add column space_id uuid;
alter table public.app_settings        add column space_id uuid;

-- audit rows carry their space (defined before the data move, which fires it)
create or replace function public.write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_log (space_id, actor, action, entity, entity_id, detail)
  values (
    (v_row->>'space_id')::uuid,
    coalesce(auth.jwt()->>'email', 'service'),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row->>'id', v_row->>'space_id'),
    v_row
  );
  return coalesce(new, old);
end;
$$;

-- ── 3. existing data moves into a "Main space" ────────────────────────────
do $move$
declare
  v_main uuid;
  v_owner uuid;
begin
  if exists (select 1 from public.telegram_accounts)
     or exists (select 1 from public.channels)
     or exists (select 1 from public.forwards)
     or exists (select 1 from public.presets)
     or exists (select 1 from public.app_members where user_id is not null) then
    insert into public.spaces (name) values ('Main space') returning id into v_main;

    update public.telegram_accounts set space_id = v_main;
    update public.channels          set space_id = v_main;
    update public.presets           set space_id = v_main;
    update public.forwards          set space_id = v_main;
    update public.incidents         set space_id = v_main;
    update public.notifications     set space_id = v_main;
    update public.audit_log         set space_id = v_main;
    update public.forum_topics      set space_id = v_main;
    update public.alert_settings    set space_id = v_main;
    update public.app_settings      set space_id = v_main;

    insert into public.space_members (space_id, user_id, role)
    select v_main, user_id, case when role = 'admin' then 'admin' else 'viewer' end
    from public.app_members where user_id is not null;

    select user_id into v_owner from public.app_members
    where role = 'admin' and user_id is not null order by created_at limit 1;
    if v_owner is not null then
      update public.space_members set role = 'owner' where space_id = v_main and user_id = v_owner;
      update public.spaces set created_by = v_owner where id = v_main;
    end if;

    insert into public.platform_admins (user_id)
    select user_id from public.app_members where role = 'admin' and user_id is not null
    on conflict do nothing;
  end if;
end
$move$;

update public.routes r set space_id = c.space_id from public.channels c where c.id = r.master_id;
update public.channel_memberships m set space_id = c.space_id from public.channels c where c.id = m.channel_id;
update public.discovered_chats d set space_id = a.space_id from public.telegram_accounts a where a.id = d.account_id;

-- rows that belong to no space (only possible when there was no data)
delete from public.notifications  where space_id is null;
delete from public.incidents      where space_id is null;
delete from public.forwards       where space_id is null;
delete from public.forum_topics   where space_id is null;
delete from public.alert_settings where space_id is null;
delete from public.app_settings   where space_id is null;
delete from public.audit_log      where space_id is null;

-- settings become one row per space
alter table public.alert_settings drop constraint alert_settings_pkey;
alter table public.alert_settings drop column id;
alter table public.alert_settings add primary key (space_id);
alter table public.app_settings drop constraint app_settings_pkey;
alter table public.app_settings drop column id;
alter table public.app_settings add primary key (space_id);

-- ── 4. constraints and indexes ────────────────────────────────────────────
do $do$
declare t text;
begin
  foreach t in array array['telegram_accounts','channels','channel_memberships','routes','presets',
                           'forwards','incidents','notifications','discovered_chats','forum_topics',
                           'alert_settings','app_settings'] loop
    execute format('alter table public.%I alter column space_id set not null', t);
    execute format(
      'alter table public.%I add constraint %I foreign key (space_id) references public.spaces(id) on delete cascade',
      t, t || '_space_id_fkey');
  end loop;
end
$do$;
-- audit_log.space_id has no FK: audit rows written while a space is being
-- deleted would otherwise violate it and block the delete.

create index telegram_accounts_space_idx   on public.telegram_accounts (space_id);
create index channels_space_idx            on public.channels (space_id);
create index channel_memberships_space_idx on public.channel_memberships (space_id);
create index routes_space_idx              on public.routes (space_id);
create index presets_space_idx             on public.presets (space_id);
create index discovered_chats_space_idx    on public.discovered_chats (space_id);
create index forwards_space_created_idx    on public.forwards (space_id, created_at desc);
create index incidents_space_seen_idx      on public.incidents (space_id, last_seen desc);
create index notifications_space_created_idx on public.notifications (space_id, created_at desc);
create index audit_log_space_created_idx   on public.audit_log (space_id, created_at desc);

-- the same chat may be used by different spaces
alter table public.channels drop constraint channels_role_tg_chat_id_key;
alter table public.channels add constraint channels_space_role_chat_key unique (space_id, role, tg_chat_id);
alter table public.presets drop constraint presets_name_key;
alter table public.presets add constraint presets_space_name_key unique (space_id, name);
alter table public.forum_topics drop constraint forum_topics_pkey;
alter table public.forum_topics add primary key (space_id, tg_chat_id, topic_id);

-- one Telegram identity lives in exactly one space: two relays polling the
-- same bot steal each other's updates, and a bot must never serve two tenants
create unique index telegram_accounts_identity_key
  on public.telegram_accounts (kind, tg_id) where tg_id is not null;

-- ── 5. old single-tenant access model goes away ───────────────────────────
do $do$
declare p record;
begin
  for p in select tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end
$do$;

drop trigger if exists enforce_invite_only on auth.users;
drop trigger if exists link_member_on_signup on auth.users;
drop function if exists public.enforce_invite_only();
drop function if exists public.link_member_on_signup();
do $notice$
declare v_pending int := (select count(*) from public.app_members where user_id is null);
begin
  if v_pending > 0 then
    raise notice 'dropping % invite(s) that were never activated — those people now sign up normally', v_pending;
  end if;
end
$notice$;
drop table public.app_members;
drop function if exists public.is_member();
drop function if exists public.is_admin();

-- ── 6. access helpers ─────────────────────────────────────────────────────
create or replace function public.my_space_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.space_id
  from public.space_members m
  join public.spaces s on s.id = m.space_id
  where m.user_id = auth.uid() and s.disabled_at is null;
$$;

create or replace function public.my_admin_space_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.space_id
  from public.space_members m
  join public.spaces s on s.id = m.space_id
  where m.user_id = auth.uid() and s.disabled_at is null and m.role in ('owner','admin');
$$;

create or replace function public.is_space_admin(p_space uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.my_admin_space_ids() s where s = p_space);
$$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

/** Spaces I belong to — including disabled ones, so the app can say so. */
create or replace function public.my_spaces()
returns table (id uuid, name text, role text, disabled boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, m.role, s.disabled_at is not null, s.created_at
  from public.space_members m
  join public.spaces s on s.id = m.space_id
  where m.user_id = auth.uid()
  order by s.created_at;
$$;

-- ── 7. sign-up: blank space, or join via invite code ──────────────────────
create or replace function public.invite_code_hash(p_code text) returns text
language sql immutable set search_path = public as $$
  select encode(
    extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'),
    'hex');
$$;

create or replace function public.invite_is_valid(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.space_invites i
    join public.spaces s on s.id = i.space_id
    where i.code_hash = public.invite_code_hash(p_code)
      and i.used_at is null and i.expires_at > now() and s.disabled_at is null
  );
$$;

create or replace function public.redeem_invite_for(p_user uuid, p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_invite public.space_invites;
begin
  select i.* into v_invite
  from public.space_invites i
  join public.spaces s on s.id = i.space_id
  where i.code_hash = public.invite_code_hash(p_code)
    and i.used_at is null and i.expires_at > now() and s.disabled_at is null
  for update of i;
  if v_invite.id is null then
    raise exception 'invalid or expired invite code';
  end if;

  insert into public.space_members (space_id, user_id, role)
  values (v_invite.space_id, p_user, v_invite.role)
  on conflict (space_id, user_id) do nothing;
  update public.space_invites set used_at = now(), used_by = p_user where id = v_invite.id;
  return v_invite.space_id;
end;
$$;

create or replace function public.gate_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_code text := nullif(btrim(new.raw_user_meta_data->>'invite_code'), '');
begin
  -- app metadata is writable only through the service-role Admin API, so an
  -- operator can still create accounts while public sign-ups are closed
  if coalesce((new.raw_app_meta_data->>'skip_signup_gate')::boolean, false) then
    return new;
  end if;
  if v_code is not null then
    if not public.invite_is_valid(v_code) then
      raise exception 'invalid or expired invite code';
    end if;
    return new; -- a valid invite works even while sign-ups are closed
  end if;
  if not coalesce((select signups_open from public.platform_settings where id = 1), false) then
    raise exception 'sign-ups are closed';
  end if;
  return new;
end;
$$;

create or replace function public.provision_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_code text := nullif(btrim(new.raw_user_meta_data->>'invite_code'), '');
  v_name text;
  v_space uuid;
begin
  if v_code is not null then
    perform public.redeem_invite_for(new.id, v_code);
    return new;
  end if;

  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'space_name'), ''),
    split_part(coalesce(new.email, 'my'), '@', 1) || '''s space');
  insert into public.spaces (name, created_by) values (left(v_name, 80), new.id) returning id into v_space;
  insert into public.space_members (space_id, user_id, role) values (v_space, new.id, 'owner');
  insert into public.alert_settings (space_id) values (v_space);
  insert into public.app_settings (space_id) values (v_space);
  return new;
end;
$$;

create trigger gate_signup before insert on auth.users
  for each row execute function public.gate_signup();
create trigger provision_user after insert on auth.users
  for each row execute function public.provision_user();

/** Pre-flight for the sign-up form: 'ok' | 'closed' | 'invalid_code'. */
create or replace function public.check_signup(p_code text default null) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if nullif(btrim(p_code), '') is not null then
    return case when public.invite_is_valid(p_code) then 'ok' else 'invalid_code' end;
  end if;
  return case
    when coalesce((select signups_open from public.platform_settings where id = 1), false) then 'ok'
    else 'closed'
  end;
end;
$$;

-- ── 8. team management ────────────────────────────────────────────────────
create or replace function public.create_space_invite(p_space uuid, p_role text default 'viewer') returns text
language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 symbols, no 0/O/1/I
  v_bytes bytea := extensions.gen_random_bytes(10);
  v_code text := '';
begin
  if not public.is_space_admin(p_space) then
    raise exception 'only space admins can create invites';
  end if;
  if p_role not in ('admin','viewer') then
    raise exception 'invalid role';
  end if;
  for i in 0..9 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  insert into public.space_invites (space_id, code_hash, role, created_by)
  values (p_space, public.invite_code_hash(v_code), p_role, auth.uid());
  return substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5);
end;
$$;

create or replace function public.redeem_space_invite(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  return public.redeem_invite_for(auth.uid(), p_code);
end;
$$;

create or replace function public.space_member_list(p_space uuid)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.space_members m
  join auth.users u on u.id = m.user_id
  where m.space_id = p_space
    and p_space in (select public.my_space_ids())
  order by m.created_at;
$$;

create or replace function public.remove_space_member(p_space uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
begin
  if not public.is_space_admin(p_space) then
    raise exception 'only space admins can remove members';
  end if;
  select role into v_role from public.space_members where space_id = p_space and user_id = p_user;
  if v_role = 'owner' then
    raise exception 'the space owner cannot be removed';
  end if;
  delete from public.space_members where space_id = p_space and user_id = p_user;
end;
$$;

create or replace function public.rename_space(p_space uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_space_admin(p_space) then
    raise exception 'only space admins can rename the space';
  end if;
  update public.spaces set name = left(btrim(p_name), 80) where id = p_space;
end;
$$;

/** Relay heartbeat for any signed-in user, without exposing instances. */
create or replace function public.relay_status()
returns table (heartbeat_at timestamptz, simulate boolean)
language sql stable security definer set search_path = public as $$
  select w.heartbeat_at, w.simulate
  from public.worker_status w
  where auth.uid() is not null
  order by w.heartbeat_at desc
  limit 1;
$$;

-- ── 9. platform admin: metadata only, never space content ─────────────────
create or replace function public.admin_list_spaces()
returns table (
  id uuid, name text, owner_email text, created_at timestamptz, disabled boolean,
  members int, bots int, channels int, routes int, forwards_24h int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only';
  end if;
  return query
  select
    s.id,
    s.name,
    (select u.email::text from public.space_members m join auth.users u on u.id = m.user_id
      where m.space_id = s.id and m.role = 'owner' order by m.created_at limit 1),
    s.created_at,
    s.disabled_at is not null,
    (select count(*)::int from public.space_members m where m.space_id = s.id),
    (select count(*)::int from public.telegram_accounts a where a.space_id = s.id and a.kind = 'bot'),
    (select count(*)::int from public.channels c where c.space_id = s.id),
    (select count(*)::int from public.routes r where r.space_id = s.id),
    (select count(*)::int from public.forwards f
      where f.space_id = s.id and f.created_at > now() - interval '24 hours')
  from public.spaces s
  order by s.created_at;
end;
$$;

create or replace function public.admin_set_space_disabled(p_space uuid, p_disabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only';
  end if;
  update public.spaces
  set disabled_at = case when p_disabled then coalesce(disabled_at, now()) else null end
  where id = p_space;
end;
$$;

create or replace function public.admin_get_signups_open() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only';
  end if;
  return (select signups_open from public.platform_settings where id = 1);
end;
$$;

create or replace function public.admin_set_signups_open(p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only';
  end if;
  update public.platform_settings set signups_open = p_open, updated_at = now() where id = 1;
end;
$$;

-- ── 10. integrity: rows stay in their space ───────────────────────────────
-- Children take their space from their parent — whatever a client sends.
create or replace function public.derive_space_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'routes' then
    select space_id into new.space_id from public.channels where id = new.master_id;
  elsif tg_table_name = 'channel_memberships' then
    select space_id into new.space_id from public.channels where id = new.channel_id;
  elsif tg_table_name = 'discovered_chats' then
    select space_id into new.space_id from public.telegram_accounts where id = new.account_id;
  elsif tg_table_name = 'forwards' then
    if new.route_id is not null then
      select space_id into new.space_id from public.routes where id = new.route_id;
    end if;
  elsif tg_table_name = 'incidents' then
    new.space_id := coalesce(
      new.space_id,
      (select space_id from public.channels where id = new.channel_id),
      (select space_id from public.telegram_accounts where id = new.account_id),
      (select space_id from public.routes where id = new.route_id));
  elsif tg_table_name = 'notifications' then
    new.space_id := coalesce(
      new.space_id,
      (select space_id from public.incidents where id = new.incident_id));
  end if;
  return new;
end;
$$;

create trigger a_derive_space before insert or update on public.routes
  for each row execute function public.derive_space_id();
create trigger a_derive_space before insert or update on public.channel_memberships
  for each row execute function public.derive_space_id();
create trigger a_derive_space before insert or update on public.discovered_chats
  for each row execute function public.derive_space_id();
create trigger a_derive_space before insert on public.forwards
  for each row execute function public.derive_space_id();
create trigger a_derive_space before insert on public.incidents
  for each row execute function public.derive_space_id();
create trigger a_derive_space before insert on public.notifications
  for each row execute function public.derive_space_id();

create or replace function public.enforce_same_space() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'routes' then
    if not exists (select 1 from public.channels where id = new.receiver_id and space_id = new.space_id) then
      raise exception 'the receiver belongs to a different space';
    end if;
    if new.sender_account_id is not null and not exists (
      select 1 from public.telegram_accounts where id = new.sender_account_id and space_id = new.space_id
    ) then
      raise exception 'the sender account belongs to a different space';
    end if;
  elsif tg_table_name = 'channel_memberships' then
    if not exists (select 1 from public.telegram_accounts where id = new.account_id and space_id = new.space_id) then
      raise exception 'the account belongs to a different space';
    end if;
  end if;
  return new;
end;
$$;

create trigger b_enforce_same_space before insert or update on public.routes
  for each row execute function public.enforce_same_space();
create trigger b_enforce_same_space before insert or update on public.channel_memberships
  for each row execute function public.enforce_same_space();

create or replace function public.forbid_space_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.space_id is distinct from old.space_id then
    raise exception 'rows cannot move between spaces';
  end if;
  return new;
end;
$$;

do $do$
declare t text;
begin
  foreach t in array array['telegram_accounts','channels','channel_memberships','routes','presets',
                           'forwards','incidents','notifications','discovered_chats','forum_topics',
                           'alert_settings','app_settings'] loop
    execute format(
      'create trigger c_forbid_space_change before update on public.%I for each row execute function public.forbid_space_change()',
      t);
  end loop;
end
$do$;

-- ── 11. row-level security ────────────────────────────────────────────────
alter table public.spaces            enable row level security;
alter table public.space_members     enable row level security;
alter table public.space_invites     enable row level security;
alter table public.platform_admins   enable row level security;
alter table public.platform_settings enable row level security;
alter table public.discovered_chats  enable row level security;
alter table public.forum_topics      enable row level security;

do $do$
declare t text;
begin
  -- space configuration: members read, space admins write
  foreach t in array array['telegram_accounts','channels','channel_memberships','routes','presets',
                           'alert_settings','app_settings'] loop
    execute format(
      'create policy space_read on public.%I for select to authenticated using (space_id in (select public.my_space_ids()))', t);
    execute format(
      'create policy space_admin_insert on public.%I for insert to authenticated with check (space_id in (select public.my_admin_space_ids()))', t);
    execute format(
      'create policy space_admin_update on public.%I for update to authenticated using (space_id in (select public.my_admin_space_ids())) with check (space_id in (select public.my_admin_space_ids()))', t);
    execute format(
      'create policy space_admin_delete on public.%I for delete to authenticated using (space_id in (select public.my_admin_space_ids()))', t);
  end loop;

  -- relay telemetry: members read, only the worker (service role) writes
  foreach t in array array['forwards','incidents','notifications','audit_log','discovered_chats','forum_topics'] loop
    execute format(
      'create policy space_read on public.%I for select to authenticated using (space_id in (select public.my_space_ids()))', t);
  end loop;
end
$do$;

create policy space_mark_read on public.notifications for update to authenticated
  using (space_id in (select public.my_space_ids()))
  with check (space_id in (select public.my_space_ids()));

create policy member_read on public.spaces for select to authenticated
  using (id in (select public.my_space_ids()));
create policy member_read on public.space_members for select to authenticated
  using (space_id in (select public.my_space_ids()));
create policy admin_read on public.space_invites for select to authenticated
  using (space_id in (select public.my_admin_space_ids()));
create policy admin_delete on public.space_invites for delete to authenticated
  using (space_id in (select public.my_admin_space_ids()));
-- worker instances are platform infrastructure; members use relay_status()
create policy platform_admin_read on public.worker_status for select to authenticated
  using ((select public.is_platform_admin()));
-- platform_admins, platform_settings: no policies — service role and RPCs only

-- ── 12. worker-facing functions ───────────────────────────────────────────
create or replace function public.claim_due_forwards(p_limit int)
returns setof public.forwards
language sql security definer set search_path = public as $$
  update public.forwards f
  set state = 'sending', updated_at = now()
  where f.id in (
    select q.id from public.forwards q
    join public.spaces s on s.id = q.space_id
    where q.state in ('queued','scheduled','held') and q.deliver_at <= now()
      and s.disabled_at is null
    order by q.deliver_at
    limit p_limit
    for update of q skip locked
  )
  returning f.*;
$$;

drop function if exists public.note_forum_topic(bigint, bigint, text);
create or replace function public.note_forum_topic(p_space uuid, p_chat bigint, p_topic bigint, p_title text)
returns void language sql security definer set search_path = public as $$
  insert into public.forum_topics (space_id, tg_chat_id, topic_id, title)
  values (p_space, p_chat, p_topic, coalesce(p_title, ''))
  on conflict (space_id, tg_chat_id, topic_id) do update
    set title = case when excluded.title <> '' then excluded.title else forum_topics.title end,
        last_seen_at = now();
$$;

-- Deliberately spans spaces: a chat id is Telegram's global identity, and after
-- a group→supergroup upgrade the old id is dead for every space that uses it.
-- Only the worker (service role) can call this, from Telegram's own event.
create or replace function public.migrate_chat_id(p_old bigint, p_new bigint)
returns void language sql security definer set search_path = public as $$
  update public.channels set tg_chat_id = p_new, chat_type = 'supergroup' where tg_chat_id = p_old;
  update public.discovered_chats set tg_chat_id = p_new, chat_type = 'supergroup'
  where tg_chat_id = p_old
    and not exists (
      select 1 from public.discovered_chats d
      where d.tg_chat_id = p_new and d.account_id = discovered_chats.account_id
    );
$$;

-- ── 13. scheduled jobs, per space ─────────────────────────────────────────
select cron.unschedule('relay-worker-watchdog');
select cron.schedule('relay-worker-watchdog', '* * * * *', $job$
  insert into public.incidents (space_id, kind, status, message)
  select s.id, 'worker_offline', 'open', 'No relay heartbeat for over 2 minutes'
  from public.spaces s
  where s.disabled_at is null
    and exists (select 1 from public.worker_status)
    and not exists (select 1 from public.worker_status where heartbeat_at > now() - interval '2 minutes')
    and exists (select 1 from public.telegram_accounts a where a.space_id = s.id)
    and not exists (
      select 1 from public.incidents i
      where i.space_id = s.id and i.kind = 'worker_offline' and i.status = 'open');

  insert into public.notifications (space_id, kind, title, body, incident_id)
  select i.space_id, 'worker_offline', 'Relay offline',
         'The relay has not sent a heartbeat for over 2 minutes.', i.id
  from public.incidents i
  where i.kind = 'worker_offline' and i.status = 'open' and i.alerted_at is null;

  update public.incidents set alerted_at = now()
  where kind = 'worker_offline' and status = 'open' and alerted_at is null;

  update public.incidents set status = 'resolved', resolved_at = now()
  where kind = 'worker_offline' and status = 'open'
    and exists (select 1 from public.worker_status where heartbeat_at > now() - interval '2 minutes');
$job$);

select cron.unschedule('relay-purge-old-logs');
select cron.schedule('relay-purge-old-logs', '17 3 * * *', $job$
  delete from public.forwards where id in (
    select f.id from public.forwards f
    join public.app_settings a on a.space_id = f.space_id
    where f.created_at < now() - make_interval(days => a.retention_days)
    limit 50000
  );
  delete from public.audit_log where created_at < now() - interval '90 days';
  delete from public.notifications where created_at < now() - interval '60 days';
  delete from public.worker_status where heartbeat_at < now() - interval '7 days';
  delete from public.incidents where status = 'resolved' and resolved_at < now() - interval '90 days';
  delete from public.space_invites where expires_at < now() - interval '30 days';
$job$);

-- ── 14. who may call what ─────────────────────────────────────────────────
-- Supabase grants EXECUTE to anon/authenticated by default: revoke, then
-- grant back only what the dashboard needs. service_role keeps its grants.
revoke execute on function public.my_space_ids()                       from public, anon, authenticated;
revoke execute on function public.my_admin_space_ids()                 from public, anon, authenticated;
revoke execute on function public.is_space_admin(uuid)                 from public, anon, authenticated;
revoke execute on function public.is_platform_admin()                  from public, anon, authenticated;
revoke execute on function public.my_spaces()                          from public, anon, authenticated;
revoke execute on function public.invite_code_hash(text)               from public, anon, authenticated;
revoke execute on function public.invite_is_valid(text)                from public, anon, authenticated;
revoke execute on function public.redeem_invite_for(uuid, text)        from public, anon, authenticated;
revoke execute on function public.gate_signup()                        from public, anon, authenticated;
revoke execute on function public.provision_user()                     from public, anon, authenticated;
revoke execute on function public.check_signup(text)                   from public, anon, authenticated;
revoke execute on function public.create_space_invite(uuid, text)      from public, anon, authenticated;
revoke execute on function public.redeem_space_invite(text)            from public, anon, authenticated;
revoke execute on function public.space_member_list(uuid)              from public, anon, authenticated;
revoke execute on function public.remove_space_member(uuid, uuid)      from public, anon, authenticated;
revoke execute on function public.rename_space(uuid, text)             from public, anon, authenticated;
revoke execute on function public.relay_status()                       from public, anon, authenticated;
revoke execute on function public.admin_list_spaces()                  from public, anon, authenticated;
revoke execute on function public.admin_set_space_disabled(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.admin_get_signups_open()             from public, anon, authenticated;
revoke execute on function public.admin_set_signups_open(boolean)      from public, anon, authenticated;
revoke execute on function public.derive_space_id()                    from public, anon, authenticated;
revoke execute on function public.enforce_same_space()                 from public, anon, authenticated;
revoke execute on function public.forbid_space_change()                from public, anon, authenticated;
revoke execute on function public.write_audit()                        from public, anon, authenticated;
revoke execute on function public.claim_due_forwards(int)              from public, anon, authenticated;
revoke execute on function public.note_forum_topic(uuid, bigint, bigint, text) from public, anon, authenticated;
revoke execute on function public.migrate_chat_id(bigint, bigint)      from public, anon, authenticated;

-- row-level security policies evaluate these as the signed-in user
grant execute on function public.my_space_ids()        to authenticated;
grant execute on function public.my_admin_space_ids()  to authenticated;
grant execute on function public.is_platform_admin()   to authenticated;

-- dashboard RPCs
grant execute on function public.is_space_admin(uuid)            to authenticated;
grant execute on function public.my_spaces()                     to authenticated;
grant execute on function public.check_signup(text)              to anon, authenticated;
grant execute on function public.create_space_invite(uuid, text) to authenticated;
grant execute on function public.redeem_space_invite(text)       to authenticated;
grant execute on function public.space_member_list(uuid)         to authenticated;
grant execute on function public.remove_space_member(uuid, uuid) to authenticated;
grant execute on function public.rename_space(uuid, text)        to authenticated;
grant execute on function public.relay_status()                  to authenticated;
grant execute on function public.admin_list_spaces()             to authenticated;
grant execute on function public.admin_set_space_disabled(uuid, boolean) to authenticated;
grant execute on function public.admin_get_signups_open()        to authenticated;
grant execute on function public.admin_set_signups_open(boolean) to authenticated;

alter publication supabase_realtime add table public.spaces, public.space_members;
