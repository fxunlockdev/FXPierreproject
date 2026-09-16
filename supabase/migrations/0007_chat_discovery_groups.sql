-- Chat discovery + groups.
--
-- Bots cannot look up invite links (t.me/+…), so private channels and groups
-- could not be added. Instead the worker records every chat a connected
-- account sees — the moment the bot is added/promoted (my_chat_member) or a
-- message is posted there — and the dashboard lets you pick from that list.
--
-- Channels, supergroups and basic groups are all valid masters and receivers.

create table public.discovered_chats (
  account_id uuid not null references public.telegram_accounts(id) on delete cascade,
  tg_chat_id bigint not null,
  chat_type text not null check (chat_type in ('channel','supergroup','group')),
  title text not null default '',
  username text,
  status text not null
    check (status in ('administrator','member','restricted','left','kicked')),
  -- can the account read every new message here (admin, or group privacy off)
  can_read boolean not null default false,
  -- can the account post here
  can_post boolean not null default false,
  last_seen_at timestamptz not null default now(),
  primary key (account_id, tg_chat_id)
);
create index discovered_chats_seen_idx on public.discovered_chats (last_seen_at desc);

alter table public.discovered_chats enable row level security;
create policy member_read on public.discovered_chats for select
  using ((select public.is_member()));

alter publication supabase_realtime add table public.discovered_chats;

-- channels now holds groups too; remember which kind each row is
alter table public.channels
  add column chat_type text check (chat_type in ('channel','supergroup','group'));

-- a basic group upgraded to a supergroup gets a new id — keep rows pointing at it
create or replace function public.migrate_chat_id(p_old bigint, p_new bigint)
returns void language sql security definer set search_path = public as $$
  update public.channels set tg_chat_id = p_new, chat_type = 'supergroup'
  where tg_chat_id = p_old;
  update public.discovered_chats set tg_chat_id = p_new, chat_type = 'supergroup'
  where tg_chat_id = p_old
    and not exists (
      select 1 from public.discovered_chats d
      where d.tg_chat_id = p_new and d.account_id = discovered_chats.account_id
    );
$$;
revoke execute on function public.migrate_chat_id(bigint, bigint) from anon, authenticated, public;
