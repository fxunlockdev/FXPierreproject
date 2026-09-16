-- Forum topics.
--
-- Groups with Topics enabled ("forums") split one chat into threads. A route
-- can now read from one topic of a forum master and post into one topic of a
-- forum receiver. Both default to NULL = whole chat (master) / General (receiver).
--
-- The Bot API cannot list a forum's topics, so the worker records every topic
-- it sees a message in (with its name when Telegram includes it).

alter table public.routes
  add column source_topic_id bigint,
  add column target_topic_id bigint;

-- The same master → receiver pair may now exist once per topic mapping.
alter table public.routes drop constraint routes_master_id_receiver_id_key;
alter table public.routes add constraint routes_master_receiver_topics_key
  unique nulls not distinct (master_id, receiver_id, source_topic_id, target_topic_id);

alter table public.channels add column is_forum boolean not null default false;
alter table public.discovered_chats add column is_forum boolean not null default false;

create table public.forum_topics (
  tg_chat_id bigint not null,
  topic_id bigint not null,
  title text not null default '',
  last_seen_at timestamptz not null default now(),
  primary key (tg_chat_id, topic_id)
);

alter table public.forum_topics enable row level security;
create policy member_read on public.forum_topics for select
  using ((select public.is_member()));

alter publication supabase_realtime add table public.forum_topics;

-- Record a topic; a known name is never overwritten by an unknown (empty) one.
create or replace function public.note_forum_topic(p_chat bigint, p_topic bigint, p_title text)
returns void language sql security definer set search_path = public as $$
  insert into public.forum_topics (tg_chat_id, topic_id, title)
  values (p_chat, p_topic, coalesce(p_title, ''))
  on conflict (tg_chat_id, topic_id) do update
    set title = case when excluded.title <> '' then excluded.title else forum_topics.title end,
        last_seen_at = now();
$$;
revoke execute on function public.note_forum_topic(bigint, bigint, text) from anon, authenticated, public;
