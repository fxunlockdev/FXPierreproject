-- Tenant isolation checks for private spaces (migration 0009).
-- Runs as real signed-in users via role + JWT claims; every check raises on
-- failure. Wrapped in a transaction and rolled back: leaves no trace.
--   docker exec -i supabase_db_<project> psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/spaces_isolation.sql

begin;

create temporary table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated;

create or replace function pg_temp.as_user(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select v from t_ids where k = p_key), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

create or replace function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

create or replace function pg_temp.new_user(p_key text, p_email text, p_meta jsonb default '{}') returns void
language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', p_email, '',
          now(), '{}', p_meta, now(), now());
  insert into t_ids values (p_key, v);
end $$;

create or replace function pg_temp.expect_error(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok   % (blocked: %)', p_label, sqlerrm;
    return;
  end;
  raise exception 'FAIL %: expected an error, statement succeeded', p_label;
end $$;

create or replace function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
  raise notice 'ok   %', p_label;
end $$;

-- ── sign-up provisions a private blank space ───────────────────────────────
select pg_temp.new_user('alice', 'alice@iso.test');
select pg_temp.new_user('bob', 'bob@iso.test', '{"space_name": "Bob Signals"}');

select pg_temp.check(
  (select count(*) from space_members m join t_ids t on t.v = m.user_id where m.role = 'owner') = 2,
  'each sign-up owns exactly one new space');
select pg_temp.check(
  (select name from spaces s join space_members m on m.space_id = s.id join t_ids t on t.v = m.user_id where t.k = 'bob') = 'Bob Signals',
  'space name taken from sign-up');
select pg_temp.check(
  (select count(*) from alert_settings a join space_members m on m.space_id = a.space_id join t_ids t on t.v = m.user_id) = 2,
  'every new space gets its own settings');

insert into t_ids select 'space_a', space_id from space_members m join t_ids t on t.v = m.user_id where t.k = 'alice';
insert into t_ids select 'space_b', space_id from space_members m join t_ids t on t.v = m.user_id where t.k = 'bob';

-- ── alice builds her setup ─────────────────────────────────────────────────
select pg_temp.as_user('alice');
insert into telegram_accounts (id, space_id, kind, label, tg_id, status)
  values ('a0000000-0000-0000-0000-00000000000b', (select v from t_ids where k = 'space_a'), 'bot', 'Alice bot', 111, 'connected');
insert into channels (id, space_id, role, tg_chat_id, title) values
  ('a0000000-0000-0000-0000-0000000000c1', (select v from t_ids where k = 'space_a'), 'master', -10011, 'Alice master'),
  ('a0000000-0000-0000-0000-0000000000c2', (select v from t_ids where k = 'space_a'), 'receiver', -10012, 'Alice receiver');
insert into routes (id, master_id, receiver_id, sender_account_id) values
  ('a0000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-0000000000c2', 'a0000000-0000-0000-0000-00000000000b');
select pg_temp.check((select space_id from routes where id = 'a0000000-0000-0000-0000-0000000000f1') = (select v from t_ids where k = 'space_a'),
  'a route takes its space from its master');

-- ── bob sees none of it and can't touch it ─────────────────────────────────
select pg_temp.as_user('bob');
select pg_temp.check((select count(*) from telegram_accounts) = 0, 'bob sees no bots from other spaces');
select pg_temp.check((select count(*) from channels) = 0, 'bob sees no channels from other spaces');
select pg_temp.check((select count(*) from routes) = 0, 'bob sees no routes from other spaces');
select pg_temp.check((select count(*) from spaces) = 1, 'bob sees only his own space');
select pg_temp.check((select count(*) from space_members) = 1, 'bob sees only his own space members');
select pg_temp.check((select count(*) from space_member_list((select v from t_ids where k = 'space_a'))) = 0,
  'bob cannot list alice''s members');

select pg_temp.expect_error(
  $q$insert into channels (space_id, role, tg_chat_id, title) values ((select v from t_ids where k = 'space_a'), 'master', -1, 'intruder')$q$,
  'bob cannot add a channel to alice''s space');
update channels set title = 'hijacked' where id = 'a0000000-0000-0000-0000-0000000000c1';
delete from routes where id = 'a0000000-0000-0000-0000-0000000000f1';

-- bob's own channel, then attempts to wire alice's things into his space
insert into channels (id, space_id, role, tg_chat_id, title) values
  ('b0000000-0000-0000-0000-0000000000c2', (select v from t_ids where k = 'space_b'), 'receiver', -10022, 'Bob receiver');
select pg_temp.expect_error(
  $q$insert into routes (master_id, receiver_id) values ('a0000000-0000-0000-0000-0000000000c1', 'b0000000-0000-0000-0000-0000000000c2')$q$,
  'bob cannot relay FROM alice''s master');
insert into channels (id, space_id, role, tg_chat_id, title) values
  ('b0000000-0000-0000-0000-0000000000c1', (select v from t_ids where k = 'space_b'), 'master', -10011, 'Bob copy of the same chat');
select pg_temp.check(true, 'the same Telegram chat can be a master in two spaces');
select pg_temp.expect_error(
  $q$insert into routes (master_id, receiver_id, sender_account_id) values ('b0000000-0000-0000-0000-0000000000c1', 'b0000000-0000-0000-0000-0000000000c2', 'a0000000-0000-0000-0000-00000000000b')$q$,
  'bob cannot send through alice''s bot');
select pg_temp.expect_error(
  $q$insert into routes (master_id, receiver_id) values ('b0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-0000000000c2')$q$,
  'bob cannot relay INTO alice''s receiver');
select pg_temp.expect_error(
  $q$insert into telegram_accounts (space_id, kind, label, tg_id, status) values ((select v from t_ids where k = 'space_b'), 'bot', 'stolen bot', 111, 'connected')$q$,
  'alice''s bot cannot also be connected in bob''s space');
select pg_temp.expect_error($q$select public.create_space_invite((select v from t_ids where k = 'space_a'), 'admin')$q$,
  'bob cannot create invites for alice''s space');
select pg_temp.expect_error($q$select * from public.admin_list_spaces()$q$, 'bob is not a platform admin');

select pg_temp.as_postgres();
select pg_temp.check((select title from channels where id = 'a0000000-0000-0000-0000-0000000000c1') = 'Alice master',
  'bob''s update of alice''s channel changed nothing');
select pg_temp.check(exists (select 1 from routes where id = 'a0000000-0000-0000-0000-0000000000f1'),
  'bob''s delete of alice''s route removed nothing');

-- ── moving rows across spaces is impossible, even for the service role ────
select pg_temp.expect_error(
  $q$update channels set space_id = (select v from t_ids where k = 'space_b') where id = 'a0000000-0000-0000-0000-0000000000c1'$q$,
  'rows cannot move between spaces');

-- ── invite codes: a teammate joins alice's space as a viewer ───────────────
select pg_temp.as_user('alice');
insert into t_ids values ('dummy', gen_random_uuid());
create temporary table t_code (code text) on commit drop;
grant all on t_code to authenticated;
insert into t_code select public.create_space_invite((select v from t_ids where k = 'space_a'), 'viewer');
select pg_temp.check((select code ~ '^[A-Z2-9]{5}-[A-Z2-9]{5}$' from t_code), 'invite code format XXXXX-XXXXX');

select pg_temp.as_postgres();
select pg_temp.check(public.check_signup((select code from t_code)) = 'ok', 'check_signup accepts a valid code');
select pg_temp.check(public.check_signup('WRONG-CODE0') = 'invalid_code', 'check_signup rejects a wrong code');
select pg_temp.new_user('carol', 'carol@iso.test', json_build_object('invite_code', (select code from t_code))::jsonb);
select pg_temp.check(
  (select count(*) from space_members m join t_ids t on t.v = m.user_id where t.k = 'carol') = 1
  and (select role from space_members m join t_ids t on t.v = m.user_id where t.k = 'carol') = 'viewer',
  'an invite sign-up joins that space (as viewer) and gets no blank space');
select pg_temp.check(public.check_signup((select code from t_code)) = 'invalid_code', 'an invite code works once');

select pg_temp.as_user('carol');
select pg_temp.check((select count(*) from channels) = 2, 'viewer carol reads alice''s channels');
select pg_temp.expect_error(
  $q$insert into channels (space_id, role, tg_chat_id, title) values ((select v from t_ids where k = 'space_a'), 'receiver', -5, 'viewer write')$q$,
  'viewer carol cannot add channels');
update routes set enabled = false where id = 'a0000000-0000-0000-0000-0000000000f1';
select pg_temp.as_postgres();
select pg_temp.check((select enabled from routes where id = 'a0000000-0000-0000-0000-0000000000f1'), 'viewer update changed nothing');

-- ── sign-ups closed: blocked, except with an invite code ───────────────────
update platform_settings set signups_open = false;
select pg_temp.check(public.check_signup(null) = 'closed', 'check_signup reports closed sign-ups');
select pg_temp.expect_error($q$select pg_temp.new_user('mallory', 'mallory@iso.test')$q$, 'closed sign-ups reject new accounts');
select pg_temp.as_user('alice');
delete from t_code;
insert into t_code select public.create_space_invite((select v from t_ids where k = 'space_a'), 'admin');
select pg_temp.as_postgres();
select pg_temp.new_user('dave', 'dave@iso.test', json_build_object('invite_code', (select code from t_code))::jsonb);
select pg_temp.check(exists (select 1 from space_members m join t_ids t on t.v = m.user_id where t.k = 'dave'),
  'a valid invite still works while sign-ups are closed');
update platform_settings set signups_open = true;

-- ── platform admin: manages spaces, never reads inside them ────────────────
insert into platform_admins (user_id) select v from t_ids where k = 'bob';
select pg_temp.as_user('bob');
select pg_temp.check((select count(*) from public.admin_list_spaces() where bots = 1 and channels = 2) >= 1,
  'platform admin sees space metadata (counts)');
select pg_temp.check((select count(*) from channels where space_id = (select v from t_ids where k = 'space_a')) = 0,
  'platform admin still cannot read another space''s channels');
select public.admin_set_space_disabled((select v from t_ids where k = 'space_a'), true);

select pg_temp.as_user('alice');
select pg_temp.check((select count(*) from channels) = 0, 'a disabled space is unreadable to its members');
select pg_temp.check((select disabled from public.my_spaces()), 'my_spaces tells the member it is disabled');

select pg_temp.as_postgres();
insert into forwards (route_id, master_channel_id, receiver_channel_id, src_message_id, state)
  values ('a0000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-0000000000c2', 99, 'queued');
select pg_temp.check((select count(*) from public.claim_due_forwards(50) where route_id = 'a0000000-0000-0000-0000-0000000000f1') = 0,
  'the worker does not deliver for a disabled space');

select pg_temp.as_user('alice');
select pg_temp.check((select count(*) from spaces) = 0, 'disabled space hidden from spaces table');
select pg_temp.as_postgres();

\echo ''
\echo 'ALL SPACE ISOLATION CHECKS PASSED'
rollback;
