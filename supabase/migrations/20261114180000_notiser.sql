-- ======================================================
-- Mobilnotiser (14 nov)
--
-- push_subscriptions: telefoner/webbläsare som vill ha
-- notiser (sparas och tas bort via funktionerna nedan).
-- profiles.notify_*: vilka notiser personen vill ha.
-- notify_plan: räknar ut vem som ska få vilken notis när
-- någon tänder en signal eller svarar. Anropas bara av
-- serverfunktionen "notify" (service_role).
-- notified: håller reda på vad som redan skickats, så att
-- ingen får samma notis två gånger.
-- ======================================================

alter table public.profiles
    add column notify_answer boolean not null default true,
    add column notify_signal boolean not null default true,
    add column notify_match boolean not null default true;

grant update (notify_answer, notify_signal, notify_match) on public.profiles to authenticated;


create table public.push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    user_agent text not null default '',
    created_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;


create table public.notified (
    key text primary key,
    created_at timestamptz not null default now()
);

alter table public.notified enable row level security;
revoke all on public.notified from anon, authenticated;


-- Spara den här telefonens notisadress
create or replace function public.save_push_subscription(
    sub_endpoint text, sub_p256dh text, sub_auth text, sub_user_agent text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Logga in först.' using errcode = 'P0001';
    end if;

    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (auth.uid(), sub_endpoint, sub_p256dh, sub_auth, left(coalesce(sub_user_agent, ''), 300))
    on conflict (endpoint) do update
        set user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            user_agent = excluded.user_agent,
            created_at = now();
end;
$$;

-- Sluta skicka till den här telefonen
create or replace function public.delete_push_subscription(sub_endpoint text)
returns void
language sql
security definer
set search_path = ''
as $$
    delete from public.push_subscriptions
    where endpoint = sub_endpoint and user_id = auth.uid();
$$;

-- Har jag notiser på någon telefon?
create or replace function public.my_push_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
    select count(*)::integer from public.push_subscriptions where user_id = auth.uid();
$$;


-- "i kväll", "i morgon", "på fredag"
create or replace function public.day_text(d date)
returns text
language sql
stable
set search_path = ''
as $$
    select case
        when d = public.app_today() then 'i kväll'
        when d = public.app_today() + 1 then 'i morgon'
        else 'på ' || (array['söndag','måndag','tisdag','onsdag','torsdag','fredag','lördag'])[extract(dow from d)::int + 1]
    end;
$$;

-- "I kväll 19 ish · Kvarnen"
create or replace function public.signal_when_text(s public.signals)
returns text
language sql
stable
set search_path = ''
as $$
    select
        initcap(left(replace(public.day_text(s.day), 'på ', ''), 1)) || substr(replace(public.day_text(s.day), 'på ', ''), 2)
        || case
            when s.start_time is null then ''
            else ' ' || case when s.time_ish then '' else 'kl. ' end
                 || extract(hour from s.start_time)::int::text
                 || case when extract(minute from s.start_time) = 0 then ''
                         else '.' || lpad(extract(minute from s.start_time)::int::text, 2, '0') end
                 || case when s.time_ish then ' ish' else '' end
           end
        || case when s.place <> '' then ' · ' || s.place else '' end;
$$;


-- Vem ska få vilken notis?
-- event 'signal': avsändaren har tänt eller ändrat sin signal.
-- event 'answer': avsändaren har svarat "Jag är på!" på target_signal.
create or replace function public.notify_plan(sender uuid, event text, target_signal uuid default null)
returns table (recipient uuid, kind text, title text, body text, tag text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    s public.signals;
    sender_name text;
    f record;
    theirs public.signals;
    k text;
begin
    delete from public.notified where created_at < now() - interval '3 days';

    select p.name into sender_name from public.profiles p where p.id = sender;
    if sender_name is null then
        return;
    end if;

    if event = 'answer' then
        select * into s from public.signals where id = target_signal and expires_at > now();
        if s.id is null then return; end if;
        if not exists (
            select 1 from public.responses r where r.signal_id = s.id and r.responder = sender
        ) then return; end if;

        k := 'ans:' || s.id || ':' || sender;
        if exists (select 1 from public.notified n where n.key = k) then return; end if;
        insert into public.notified (key) values (k);

        if (select p.notify_answer from public.profiles p where p.id = s.owner) then
            recipient := s.owner;
            kind := 'answer';
            title := sender_name || ' är på! 🍻';
            body := 'Din signal: ' || public.signal_when_text(s);
            tag := 'answer-' || s.id || '-' || sender;
            return next;
        end if;
        return;
    end if;

    if event = 'signal' then
        select * into s from public.signals where owner = sender and expires_at > now();
        if s.id is null then return; end if;

        for f in
            select fr.friend as id, p.name, p.notify_signal, p.notify_match
            from public.friends fr
            join public.profiles p on p.id = fr.friend
            where fr.owner = sender
        loop
            if not public.can_see_signal(s, f.id) then
                continue;
            end if;

            -- Har vännen en signal samma dag som jag får se? Då är det en match.
            select * into theirs from public.signals t
            where t.owner = f.id and t.day = s.day and t.expires_at > now();

            if theirs.id is not null and public.can_see_signal(theirs, sender) then
                k := 'match:' || least(sender, f.id) || ':' || greatest(sender, f.id) || ':' || s.day;
                if not exists (select 1 from public.notified n where n.key = k) then
                    insert into public.notified (key) values (k);
                    if f.notify_match then
                        recipient := f.id; kind := 'match';
                        title := 'Du och ' || sender_name || ' är båda sugna ' || public.day_text(s.day) || '!';
                        body := sender_name || ': ' || public.signal_when_text(s);
                        tag := 'match-' || s.day || '-' || sender;
                        return next;
                    end if;
                    if (select p.notify_match from public.profiles p where p.id = sender) then
                        recipient := sender; kind := 'match';
                        title := 'Du och ' || f.name || ' är båda sugna ' || public.day_text(theirs.day) || '!';
                        body := f.name || ': ' || public.signal_when_text(theirs);
                        tag := 'match-' || s.day || '-' || f.id;
                        return next;
                    end if;
                end if;
                continue;
            end if;

            k := 'sig:' || s.id || ':' || f.id;
            if exists (select 1 from public.notified n where n.key = k) then
                continue;
            end if;
            insert into public.notified (key) values (k);

            if f.notify_signal then
                recipient := f.id; kind := 'signal';
                title := sender_name || ' är sugen på en öl';
                body := public.signal_when_text(s);
                tag := 'signal-' || s.id;
                return next;
            end if;
        end loop;
    end if;
end;
$$;


revoke execute on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke execute on function public.delete_push_subscription(text) from public, anon;
revoke execute on function public.my_push_count() from public, anon;
revoke execute on function public.signal_when_text(public.signals) from public, anon, authenticated;
revoke execute on function public.day_text(date) from public, anon, authenticated;
revoke execute on function public.notify_plan(uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;
grant execute on function public.my_push_count() to authenticated;
grant execute on function public.signal_when_text(public.signals) to service_role;
grant execute on function public.day_text(date) to service_role;
grant execute on function public.notify_plan(uuid, text, uuid) to service_role;
grant select, delete on public.push_subscriptions to service_role;
