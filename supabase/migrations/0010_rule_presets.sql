-- Reusable rule sets.
--
-- Filters and transforms had to be retyped on every route. A preset holds one
-- set of rules; any number of routes point at it and follow its edits. A route
-- without a preset keeps using its own rules, exactly as before.

alter table public.presets add column updated_at timestamptz not null default now();
create trigger touch_presets before update on public.presets
  for each row execute function public.touch_updated_at();
create trigger audit_presets after insert or update or delete on public.presets
  for each row execute function public.write_audit();

alter table public.routes add column preset_id uuid references public.presets(id) on delete set null;
create index routes_preset_idx on public.routes (preset_id) where preset_id is not null;

-- A route may only use a preset of its own space (the same rule that already
-- guards its receiver and sender account).
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
    if new.preset_id is not null and not exists (
      select 1 from public.presets where id = new.preset_id and space_id = new.space_id
    ) then
      raise exception 'the preset belongs to a different space';
    end if;
  elsif tg_table_name = 'channel_memberships' then
    if not exists (select 1 from public.telegram_accounts where id = new.account_id and space_id = new.space_id) then
      raise exception 'the account belongs to a different space';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.enforce_same_space() from public, anon, authenticated;

-- the dashboard shows presets live, and the relay reloads when one changes
alter publication supabase_realtime add table public.presets;
