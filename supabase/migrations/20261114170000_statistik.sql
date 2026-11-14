-- ======================================================
-- Statistik för admin (14 nov)
--
-- profiles.last_seen_at: när personen senast öppnade
-- appen (touch_seen, anropas av appen).
-- activity_log: tända signaler och "Jag är på!" sparas
-- som händelser, eftersom signalerna själva försvinner.
-- get_stats visar bara siffror, aldrig vem.
-- ======================================================

alter table public.profiles
    add column last_seen_at timestamptz;

create table public.activity_log (
    id bigint generated always as identity primary key,
    user_id uuid references public.profiles (id) on delete cascade,
    kind text not null check (kind in ('signal', 'answer')),
    created_at timestamptz not null default now()
);

create index activity_log_created_idx on public.activity_log (created_at);

alter table public.activity_log enable row level security;
revoke all on public.activity_log from anon, authenticated;


-- Appen säger till när den öppnas
create or replace function public.touch_seen()
returns void
language sql
security definer
set search_path = ''
as $$
    update public.profiles set last_seen_at = now() where id = auth.uid();
$$;


-- Logga när en signal tänds (inte när den ändras) och när
-- någon svarar
create or replace function public.log_signal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.activity_log (user_id, kind) values (new.owner, 'signal');
    return new;
end;
$$;

create trigger signals_log_insert
after insert on public.signals
for each row execute function public.log_signal();

create or replace function public.log_answer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.activity_log (user_id, kind) values (new.responder, 'answer');
    return new;
end;
$$;

create trigger responses_log_insert
after insert on public.responses
for each row execute function public.log_answer();


-- Siffrorna
create or replace function public.get_stats()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    result json;
begin
    if not public.is_admin() then
        raise exception 'Bara för admin.' using errcode = 'P0001';
    end if;

    select json_build_object(
        'users_total',      (select count(*) from public.profiles),
        'users_new_7d',     (select count(*) from public.profiles where created_at > now() - interval '7 days'),
        'active_1d',        (select count(*) from public.profiles where last_seen_at > now() - interval '1 day'),
        'active_7d',        (select count(*) from public.profiles where last_seen_at > now() - interval '7 days'),
        'with_friends',     (select count(distinct owner) from public.friends),
        'friendships',      (select count(*) / 2 from public.friends),
        'sorted_share',     (select round(100.0 * count(*) filter (where list_id is not null) / nullif(count(*), 0)) from public.friends),
        'signals_now',      (select count(*) from public.signals where expires_at > now()),
        'signals_7d',       (select count(*) from public.activity_log where kind = 'signal' and created_at > now() - interval '7 days'),
        'signal_users_7d',  (select count(distinct user_id) from public.activity_log where kind = 'signal' and created_at > now() - interval '7 days'),
        'answers_7d',       (select count(*) from public.activity_log where kind = 'answer' and created_at > now() - interval '7 days'),
        'since',            (select min(created_at) from public.activity_log)
    ) into result;

    return result;
end;
$$;

revoke execute on function public.touch_seen() from public, anon;
revoke execute on function public.get_stats() from public, anon;
revoke execute on function public.log_signal() from public, anon, authenticated;
revoke execute on function public.log_answer() from public, anon, authenticated;
grant execute on function public.touch_seen() to authenticated;
grant execute on function public.get_stats() to authenticated;
