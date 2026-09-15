-- Delayed/scheduled forwards must survive restarts, so the transformed
-- content is persisted with the queue row.
alter table public.forwards add column payload jsonb;
