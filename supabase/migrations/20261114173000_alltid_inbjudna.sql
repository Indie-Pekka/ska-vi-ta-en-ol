-- ======================================================
-- "Närmaste" heter nu "Alltid inbjudna" (14 nov)
--
-- Nya konton får det nya namnet. Befintliga listor byter
-- namn om de fortfarande heter Närmaste (har man döpt om
-- sin lista själv får den vara).
-- ======================================================

update public.lists
set name = 'Alltid inbjudna'
where always and name = 'Närmaste';

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
    values (new.id, 'Alltid inbjudna', true, 0);

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
