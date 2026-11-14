-- ======================================================
-- Feedbacklistan i appen, bara för admin (14 nov)
--
-- Admin = det allra första kontot (Hugo, skapat via
-- ?forsta). Fler kan läggas till i tabellen app_admins.
-- ======================================================

create table public.app_admins (
    user_id uuid primary key references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;

insert into public.app_admins (user_id)
select p.id from public.profiles p
order by p.created_at
limit 1
on conflict do nothing;

-- ny | klar
alter table public.feedback
    add column status text not null default 'ny' check (status in ('ny', 'klar'));


create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.app_admins a where a.user_id = auth.uid());
$$;

create or replace function public.get_feedback()
returns table (
    id uuid,
    author_name text,
    kind text,
    message text,
    device text,
    status text,
    created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'Bara för admin.' using errcode = 'P0001';
    end if;

    return query
    select f.id, f.author_name, f.kind, f.message, f.device, f.status, f.created_at
    from public.feedback f
    order by (f.status = 'klar'), f.created_at desc
    limit 500;
end;
$$;

create or replace function public.set_feedback_status(target uuid, new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'Bara för admin.' using errcode = 'P0001';
    end if;

    update public.feedback set status = new_status where id = target;
end;
$$;

revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.get_feedback() from public, anon;
revoke execute on function public.set_feedback_status(uuid, text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.get_feedback() to authenticated;
grant execute on function public.set_feedback_status(uuid, text) to authenticated;
