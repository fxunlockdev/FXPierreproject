-- Supabase security-advisor follow-ups after 0005.
--
-- Trigger functions were callable through PostgREST RPC by anon/authenticated.
-- Triggers fire as the table owner, so revoking caller EXECUTE is safe.
revoke execute on function public.enforce_invite_only() from anon, authenticated, public;
revoke execute on function public.link_member_on_signup() from anon, authenticated, public;
revoke execute on function public.notifications_readonly_guard() from anon, authenticated, public;
do $$
begin
  -- platform-added on the hosted project; absent in local stacks
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
  end if;
end $$;
revoke execute on function public.write_audit() from anon, authenticated, public;
revoke execute on function public.touch_updated_at() from anon, authenticated, public;

-- touch_updated_at ran with a mutable search_path.
alter function public.touch_updated_at() set search_path = public;

-- is_member()/is_admin() MUST stay executable by `authenticated`: RLS policy
-- expressions evaluate them as the querying role. anon gets nothing from them
-- (auth.uid() is null) but has no reason to call them either.
revoke execute on function public.is_member() from anon, public;
revoke execute on function public.is_admin() from anon, public;
