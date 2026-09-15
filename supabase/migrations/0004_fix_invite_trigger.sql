-- The invite gate ran as BEFORE INSERT and linked user_id before the
-- auth.users row existed, breaking the FK. Split: check BEFORE, link AFTER.
create or replace function public.enforce_invite_only() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.app_members where email = lower(new.email)) then
    raise exception 'signups are invite-only';
  end if;
  return new;
end;
$$;

create or replace function public.link_member_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.app_members set user_id = new.id where email = lower(new.email);
  return new;
end;
$$;

drop trigger if exists link_member_on_signup on auth.users;
create trigger link_member_on_signup
  after insert on auth.users
  for each row execute function public.link_member_on_signup();
