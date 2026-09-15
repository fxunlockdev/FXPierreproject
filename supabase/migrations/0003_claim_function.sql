-- Atomic queue claim for the worker (safe even with multiple instances).
create or replace function public.claim_due_forwards(p_limit int)
returns setof public.forwards
language sql
security definer set search_path = public as $$
  update public.forwards f
  set state = 'sending', updated_at = now()
  where f.id in (
    select id from public.forwards
    where state in ('queued','scheduled','held') and deliver_at <= now()
    order by deliver_at
    limit p_limit
    for update skip locked
  )
  returning f.*;
$$;

revoke execute on function public.claim_due_forwards(int) from anon, authenticated, public;

-- The audit trigger on channels fired on every last_message_at touch,
-- flooding the audit log. Limit it to meaningful config columns.
drop trigger audit_channels on public.channels;
create trigger audit_channels
  after insert or delete
    or update of role, title, username, invite_link, enabled
  on public.channels
  for each row execute function public.write_audit();
