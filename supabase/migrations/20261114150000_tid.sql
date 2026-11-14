-- ======================================================
-- Förslag på tid i signalen (14 nov)
--
-- start_time = föreslagen tid (valfri), time_ish = "ish",
-- t.ex. "19 ish".
-- ======================================================

alter table public.signals
    add column start_time time,
    add column time_ish boolean not null default false;


-- Kontroll innan signalen sparas (+ ish kräver en tid)
create or replace function public.signals_before_save()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    today date := public.app_today();
begin
    if new.day < today or new.day > today + 6 then
        raise exception 'Välj en dag den närmaste veckan.'
            using errcode = 'P0001';
    end if;

    new.place := btrim(coalesce(new.place, ''));

    if new.start_time is null then
        new.time_ish := false;
    end if;

    -- Bara egna listor, och inte Närmaste (den ser alltid)
    new.lists := coalesce(array(
        select l.id
        from public.lists l
        where l.owner = new.owner
          and not l.always
          and l.id = any (coalesce(new.lists, '{}'))
    ), '{}');

    -- Slocknar kl. 02 natten efter dagen
    new.expires_at := ((new.day + 1)::timestamp + interval '2 hours')
        at time zone 'Europe/Stockholm';

    new.updated_at := now();

    if tg_op = 'UPDATE' then
        new.id := old.id;
        new.owner := old.owner;
        new.created_at := old.created_at;
    end if;

    return new;
end;
$$;


-- Tänd eller ändra sin signal (nu med tid)
drop function public.set_signal(date, text, uuid[]);

create function public.set_signal(
    signal_day date,
    signal_place text,
    signal_lists uuid[],
    signal_time time default null,
    signal_ish boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
begin
    if me is null then
        raise exception 'Logga in först.' using errcode = 'P0001';
    end if;

    -- En slocknad signal räknas inte: börja om
    delete from public.signals where owner = me and expires_at <= now();

    -- Byts dagen gäller gamla svar inte längre
    delete from public.responses r
    using public.signals s
    where r.signal_id = s.id
      and s.owner = me
      and s.day is distinct from signal_day;

    insert into public.signals (owner, day, place, lists, start_time, time_ish)
    values (me, signal_day, coalesce(signal_place, ''), coalesce(signal_lists, '{}'),
            signal_time, coalesce(signal_ish, false))
    on conflict (owner) do update
        set day = excluded.day,
            place = excluded.place,
            lists = excluded.lists,
            start_time = excluded.start_time,
            time_ish = excluded.time_ish;
end;
$$;

revoke execute on function public.set_signal(date, text, uuid[], time, boolean) from public, anon;
grant execute on function public.set_signal(date, text, uuid[], time, boolean) to authenticated;


-- Sugna vänner (nu med tid)
drop function public.get_feed();

create function public.get_feed()
returns table (
    signal_id uuid,
    owner_id uuid,
    owner_name text,
    day date,
    place text,
    start_time time,
    time_ish boolean,
    updated_at timestamptz,
    answered boolean,
    both_keen boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select s.id,
           s.owner,
           p.name,
           s.day,
           s.place,
           s.start_time,
           s.time_ish,
           s.updated_at,
           exists (
               select 1 from public.responses r
               where r.signal_id = s.id and r.responder = auth.uid()
           ),
           exists (
               select 1 from public.signals m
               where m.owner = auth.uid()
                 and m.day = s.day
                 and public.can_see_signal(m, s.owner)
           )
    from public.signals s
    join public.profiles p on p.id = s.owner
    where auth.uid() is not null
      and public.can_see_signal(s, auth.uid())
    order by s.day, s.start_time nulls last, s.updated_at desc;
$$;

revoke execute on function public.get_feed() from public, anon;
grant execute on function public.get_feed() to authenticated;
