-- Local development / e2e seed. Never applied to the hosted project.
insert into public.app_members (email, role)
values ('e2e@switchyard.test', 'admin')
on conflict (email) do update set role = 'admin';
