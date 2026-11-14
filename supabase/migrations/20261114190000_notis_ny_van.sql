-- ======================================================
-- Notis när någon blir ens vän (14 nov)
--
-- Den som bjöd in får veta att en ny vän finns och behöver
-- läggas i en lista. Valbar under Konto (notify_friend).
-- ======================================================

alter table public.profiles
    add column notify_friend boolean not null default true;

grant update (notify_friend) on public.profiles to authenticated;

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

    -- Någon har nyss blivit vän med mig (nytt konto via min länk,
    -- eller tackat ja till min inbjudan)
    if event = 'friend' then
        for f in
            select fr.owner as id
            from public.friends fr
            join public.profiles p on p.id = fr.owner
            where fr.friend = sender
              and fr.created_at > now() - interval '15 minutes'
              and fr.list_id is null
              and not fr.hidden
              and p.notify_friend
        loop
            k := 'friend:' || f.id || ':' || sender;
            if exists (select 1 from public.notified n where n.key = k) then
                continue;
            end if;
            insert into public.notified (key) values (k);
            recipient := f.id; kind := 'friend';
            title := sender_name || ' är din vän i appen nu';
            body := 'Lägg ' || sender_name || ' i en lista, så ser hen när du är sugen.';
            tag := 'friend-' || sender;
            return next;
        end loop;
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

revoke execute on function public.notify_plan(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.notify_plan(uuid, text, uuid) to service_role;
