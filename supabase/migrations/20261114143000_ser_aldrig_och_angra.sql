-- ======================================================
-- "Ser aldrig" och ångra borttagen vän (14 nov)
--
-- hidden = vännen finns kvar men ligger inte i någon lista
-- och ser aldrig signalen. Skiljs från "Inte sorterad"
-- (nya vänner som man ännu inte valt lista för).
--
-- Borttagna vänskaper sparas en kort stund i
-- removed_friends så att man kan ångra.
-- ======================================================

alter table public.friends
    add column hidden boolean not null default false;

-- list_id och hidden hänger ihop
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

    -- Ny lista vald = inte längre dold; dold = ingen lista
    if new.list_id is not null and new.list_id is distinct from old.list_id then
        new.hidden := false;
    elsif new.hidden then
        new.list_id := null;
    end if;

    -- Bara listan och dold får ändras
    new.owner := old.owner;
    new.friend := old.friend;
    new.created_at := old.created_at;
    return new;
end;
$$;

grant update (hidden) on public.friends to authenticated;


-- Nyss borttagna vänskaper (för Ångra)
create table public.removed_friends (
    owner uuid not null,
    friend uuid not null,
    list_id uuid,
    hidden boolean not null default false,
    removed_by uuid not null,
    removed_at timestamptz not null default now(),
    primary key (owner, friend)
);

alter table public.removed_friends enable row level security;
revoke all on public.removed_friends from anon, authenticated;


-- Ta bort en vän (åt båda håll), spara för Ångra
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

    -- Städa gamla
    delete from public.removed_friends where removed_at < now() - interval '1 day';

    insert into public.removed_friends (owner, friend, list_id, hidden, removed_by, removed_at)
    select f.owner, f.friend, f.list_id, f.hidden, me, now()
    from public.friends f
    where (f.owner = me and f.friend = friend_id)
       or (f.owner = friend_id and f.friend = me)
    on conflict (owner, friend) do update
        set list_id = excluded.list_id,
            hidden = excluded.hidden,
            removed_by = excluded.removed_by,
            removed_at = excluded.removed_at;

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


-- Ångra: återställ vänskapen som den var (inom 10 minuter)
create or replace function public.restore_friend(friend_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
    restored integer;
begin
    if me is null then
        raise exception 'Logga in först.' using errcode = 'P0001';
    end if;

    insert into public.friends (owner, friend, list_id, hidden)
    select r.owner,
           r.friend,
           case when exists (
               select 1 from public.lists l where l.id = r.list_id and l.owner = r.owner
           ) then r.list_id end,
           r.hidden
    from public.removed_friends r
    where r.removed_by = me
      and r.removed_at > now() - interval '10 minutes'
      and ((r.owner = me and r.friend = friend_id)
        or (r.owner = friend_id and r.friend = me))
      and exists (select 1 from public.profiles p where p.id = friend_id)
    on conflict (owner, friend) do nothing;

    get diagnostics restored = row_count;

    delete from public.removed_friends r
    where r.removed_by = me
      and ((r.owner = me and r.friend = friend_id)
        or (r.owner = friend_id and r.friend = me));

    if restored = 0 and not exists (
        select 1 from public.friends f where f.owner = me and f.friend = friend_id
    ) then
        raise exception 'Det går inte att ångra längre. Bjud in vännen igen.'
            using errcode = 'P0001';
    end if;
end;
$$;

revoke execute on function public.restore_friend(uuid) from public, anon;
grant execute on function public.restore_friend(uuid) to authenticated;
