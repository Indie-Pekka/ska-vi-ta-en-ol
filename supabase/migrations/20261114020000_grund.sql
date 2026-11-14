-- ======================================================
-- Ska vi ta en öl? – grunddatabas
--
-- Principen: ingen kan läsa någon annans listor, och
-- ingen kan läsa en signal direkt. Vänners signaler och
-- svar går bara via funktionerna längre ner, som räknar
-- ut vem som får se vad och aldrig skickar med listorna.
--
-- "Dag" i appen byter kl. 02 (svensk tid), samma tid som
-- signalerna slocknar.
-- ======================================================

create extension if not exists pgcrypto with schema extensions;


-- ======================================================
-- TABELLER
-- ======================================================

-- Personer (namnet som vänner ser)
create table public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    name text not null check (char_length(name) between 1 and 40),
    created_at timestamptz not null default now()
);

-- Personens inbjudningskod (bara personen själv ser den)
create table public.invites (
    owner uuid primary key references public.profiles (id) on delete cascade,
    code text not null unique,
    created_at timestamptz not null default now()
);

-- Listor. "always" = Närmaste, ser alltid signalen.
create table public.lists (
    id uuid primary key default gen_random_uuid(),
    owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
    name text not null check (char_length(name) between 1 and 30),
    always boolean not null default false,
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);

create index lists_owner_idx on public.lists (owner);

-- Vänskap, en rad per riktning. owner har lagt friend i
-- list_id (tomt = inte sorterad ännu, ser ingenting).
create table public.friends (
    owner uuid not null references public.profiles (id) on delete cascade,
    friend uuid not null references public.profiles (id) on delete cascade,
    list_id uuid references public.lists (id) on delete set null,
    created_at timestamptz not null default now(),
    primary key (owner, friend),
    check (owner <> friend)
);

create index friends_friend_idx on public.friends (friend);

-- Signalen. En per person åt gången.
create table public.signals (
    id uuid primary key default gen_random_uuid(),
    owner uuid not null unique references public.profiles (id) on delete cascade,
    day date not null,
    place text not null default '' check (char_length(place) <= 60),
    lists uuid[] not null default '{}',
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- "Jag är på!"
create table public.responses (
    signal_id uuid not null references public.signals (id) on delete cascade,
    responder uuid not null references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (signal_id, responder)
);


-- ======================================================
-- HJÄLPFUNKTIONER
-- ======================================================

-- Dagens datum i appen (byter kl. 02 svensk tid)
create or replace function public.app_today()
returns date
language sql
stable
set search_path = ''
as $$
    select ((now() at time zone 'Europe/Stockholm') - interval '2 hours')::date;
$$;

-- Ny slumpad kod, t.ex. "k7m2q9xw4t"
create or replace function public.random_code()
returns text
language sql
volatile
set search_path = ''
as $$
    select string_agg(
        substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + (get_byte(b, i) % 31), 1),
        ''
    )
    from (select extensions.gen_random_bytes(10) as b) r,
         generate_series(0, 9) as i;
$$;

-- Får viewer se signalen s? Bara för funktionerna nedan.
create or replace function public.can_see_signal(s public.signals, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select s.owner <> viewer
       and s.expires_at > now()
       and exists (
            select 1
            from public.friends f
            join public.lists l on l.id = f.list_id
            where f.owner = s.owner
              and f.friend = viewer
              and (l.always or l.id = any (s.lists))
       );
$$;


-- ======================================================
-- SIGNALEN: kontroll innan den sparas
-- ======================================================

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

create trigger signals_before_save
before insert or update on public.signals
for each row execute function public.signals_before_save();

-- En gammal, slocknad signal ersätts när man tänder en ny:
-- appen tar bort den först (se set_signal).


-- ======================================================
-- VÄNNER: list_id måste vara en egen lista
-- ======================================================

create or replace function public.friends_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.list_id is not null and not exists (
        select 1 from public.lists l
        where l.id = new.list_id and l.owner = old.owner
    ) then
        raise exception 'Listan finns inte.' using errcode = 'P0001';
    end if;

    -- Bara listan får ändras
    new.owner := old.owner;
    new.friend := old.friend;
    new.created_at := old.created_at;
    return new;
end;
$$;

create trigger friends_before_update
before update on public.friends
for each row execute function public.friends_before_update();


-- ======================================================
-- NY ANVÄNDARE
--
-- Körs när ett konto skapas. Kräver en giltig inbjudan i
-- kontots metadata (invite), utom för allra första
-- kontot. Skapar profil, listan Närmaste, egen kod och
-- vänskap med den som bjöd in (osorterad åt båda håll).
-- ======================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    invite_code text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'invite', '')));
    display_name text := btrim(coalesce(new.raw_user_meta_data ->> 'name', ''));
    inviter uuid;
    first_user boolean;
begin
    -- Alla nya konton tar samma lås, så att bara ett
    -- konto kan bli "första kontot".
    perform pg_advisory_xact_lock(hashtext('ska-vi-ta-en-ol:new-user'));

    select not exists (select 1 from public.profiles) into first_user;

    if invite_code <> '' then
        select i.owner into inviter
        from public.invites i
        where i.code = invite_code;
    end if;

    if inviter is null and not first_user then
        raise exception 'Inbjudan gäller inte längre. Be om en ny länk.'
            using errcode = 'P0001';
    end if;

    if display_name = '' then
        display_name := split_part(coalesce(new.email, ''), '@', 1);
    end if;

    display_name := left(display_name, 40);

    if display_name = '' then
        display_name := 'Ny vän';
    end if;

    insert into public.profiles (id, name) values (new.id, display_name);

    insert into public.lists (owner, name, always, sort_order)
    values (new.id, 'Närmaste', true, 0);

    insert into public.invites (owner, code)
    values (new.id, public.random_code());

    if inviter is not null then
        insert into public.friends (owner, friend) values (inviter, new.id)
        on conflict do nothing;
        insert into public.friends (owner, friend) values (new.id, inviter)
        on conflict do nothing;
    end if;

    return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();


-- ======================================================
-- FUNKTIONER SOM APPEN ANROPAR
-- ======================================================

-- Vem bjuder in? (Före registrering, alla får fråga.)
create or replace function public.invite_info(invite_code text)
returns table (inviter_name text)
language sql
stable
security definer
set search_path = ''
as $$
    select p.name
    from public.invites i
    join public.profiles p on p.id = i.owner
    where i.code = lower(btrim(coalesce(invite_code, '')));
$$;

-- Bli vän via inbjudan (för den som redan har konto)
create or replace function public.accept_invite(invite_code text)
returns table (inviter_name text, already_friends boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    inviter uuid;
    was_friends boolean;
begin
    if me is null then
        raise exception 'Logga in först.' using errcode = 'P0001';
    end if;

    select i.owner into inviter
    from public.invites i
    where i.code = lower(btrim(coalesce(invite_code, '')));

    if inviter is null then
        raise exception 'Inbjudan gäller inte längre. Be om en ny länk.'
            using errcode = 'P0001';
    end if;

    if inviter = me then
        raise exception 'Det där är din egen inbjudan.' using errcode = 'P0001';
    end if;

    select exists (
        select 1 from public.friends f where f.owner = me and f.friend = inviter
    ) into was_friends;

    insert into public.friends (owner, friend) values (inviter, me)
    on conflict do nothing;
    insert into public.friends (owner, friend) values (me, inviter)
    on conflict do nothing;

    return query
    select p.name, was_friends from public.profiles p where p.id = inviter;
end;
$$;

-- Ta bort en vän (åt båda håll)
create or replace function public.remove_friend(friend_id uuid)
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

    delete from public.friends
    where (owner = me and friend = friend_id)
       or (owner = friend_id and friend = me);

    -- Svar mellan oss försvinner också
    delete from public.responses r
    using public.signals s
    where r.signal_id = s.id
      and ((s.owner = me and r.responder = friend_id)
        or (s.owner = friend_id and r.responder = me));
end;
$$;

-- Ny inbjudningskod (den gamla länken slutar fungera)
create or replace function public.new_invite_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    fresh text := public.random_code();
begin
    if me is null then
        raise exception 'Logga in först.' using errcode = 'P0001';
    end if;

    update public.invites set code = fresh, created_at = now()
    where owner = me;

    return fresh;
end;
$$;

-- Tänd eller ändra sin signal
create or replace function public.set_signal(signal_day date, signal_place text, signal_lists uuid[])
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

    insert into public.signals (owner, day, place, lists)
    values (me, signal_day, coalesce(signal_place, ''), coalesce(signal_lists, '{}'))
    on conflict (owner) do update
        set day = excluded.day,
            place = excluded.place,
            lists = excluded.lists;
end;
$$;

-- Släck sin signal
create or replace function public.clear_signal()
returns void
language sql
security definer
set search_path = ''
as $$
    delete from public.signals where owner = auth.uid();
$$;

-- Sugna vänner: signaler jag får se. Listorna skickas
-- aldrig med. "both" = jag har också en signal samma dag
-- som den här vännen får se.
create or replace function public.get_feed()
returns table (
    signal_id uuid,
    owner_id uuid,
    owner_name text,
    day date,
    place text,
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
    order by s.day, s.updated_at desc;
$$;

-- "Jag är på!"
create or replace function public.answer_signal(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    s public.signals;
begin
    if me is null then
        raise exception 'Logga in först.' using errcode = 'P0001';
    end if;

    select * into s from public.signals where id = target;

    if s.id is null or not public.can_see_signal(s, me) then
        raise exception 'Signalen finns inte längre.' using errcode = 'P0001';
    end if;

    insert into public.responses (signal_id, responder)
    values (target, me)
    on conflict do nothing;
end;
$$;

-- Ångra "Jag är på!"
create or replace function public.unanswer_signal(target uuid)
returns void
language sql
security definer
set search_path = ''
as $$
    delete from public.responses
    where signal_id = target and responder = auth.uid();
$$;

-- Vilka har svarat på min signal?
create or replace function public.get_my_responses()
returns table (responder_id uuid, responder_name text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
    select r.responder, p.name, r.created_at
    from public.signals s
    join public.responses r on r.signal_id = s.id
    join public.profiles p on p.id = r.responder
    where s.owner = auth.uid()
      and s.expires_at > now()
      -- bara de som fortfarande är vänner
      and exists (
          select 1 from public.friends f
          where f.owner = s.owner and f.friend = r.responder
      )
    order by r.created_at;
$$;


-- ======================================================
-- BEHÖRIGHETER (RLS)
-- ======================================================

alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.lists enable row level security;
alter table public.friends enable row level security;
alter table public.signals enable row level security;
alter table public.responses enable row level security;

-- Profiler: sig själv och sina vänner
create policy "profiles_select_self_or_friend" on public.profiles
for select to authenticated
using (
    id = (select auth.uid())
    or exists (
        select 1 from public.friends f
        where f.owner = (select auth.uid()) and f.friend = profiles.id
    )
);

create policy "profiles_update_self" on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- Inbjudan: bara egen
create policy "invites_select_self" on public.invites
for select to authenticated
using (owner = (select auth.uid()));

-- Listor: bara egna. Närmaste kan inte tas bort.
create policy "lists_select_own" on public.lists
for select to authenticated
using (owner = (select auth.uid()));

create policy "lists_insert_own" on public.lists
for insert to authenticated
with check (owner = (select auth.uid()) and not always);

create policy "lists_update_own" on public.lists
for update to authenticated
using (owner = (select auth.uid()))
with check (owner = (select auth.uid()));

create policy "lists_delete_own" on public.lists
for delete to authenticated
using (owner = (select auth.uid()) and not always);

-- Vänner: bara egna rader (där man själv sorterar)
create policy "friends_select_own" on public.friends
for select to authenticated
using (owner = (select auth.uid()));

create policy "friends_update_own" on public.friends
for update to authenticated
using (owner = (select auth.uid()))
with check (owner = (select auth.uid()));

-- Signaler: bara egen (vänners via get_feed)
create policy "signals_select_own" on public.signals
for select to authenticated
using (owner = (select auth.uid()));

-- Svar: inga direkta rättigheter (allt via funktionerna)

-- Närmaste-flaggan får inte ändras
create or replace function public.lists_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.always := old.always;
    new.owner := old.owner;
    return new;
end;
$$;

create trigger lists_before_update
before update on public.lists
for each row execute function public.lists_before_update();


-- ======================================================
-- RÄTTIGHETER FÖR ROLLERNA
-- ======================================================

revoke all on all tables in schema public from anon, authenticated;

grant select, update (name) on public.profiles to authenticated;
grant select on public.invites to authenticated;
grant select, delete on public.lists to authenticated;
grant insert (name, sort_order) on public.lists to authenticated;
grant update (name, sort_order) on public.lists to authenticated;
grant select, update (list_id) on public.friends to authenticated;
grant select on public.signals to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.invite_info(text) to anon, authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.new_invite_code() to authenticated;
grant execute on function public.set_signal(date, text, uuid[]) to authenticated;
grant execute on function public.clear_signal() to authenticated;
grant execute on function public.get_feed() to authenticated;
grant execute on function public.answer_signal(uuid) to authenticated;
grant execute on function public.unanswer_signal(uuid) to authenticated;
grant execute on function public.get_my_responses() to authenticated;
grant execute on function public.app_today() to anon, authenticated;
