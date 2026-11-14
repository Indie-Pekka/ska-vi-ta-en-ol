-- ======================================================
-- Feedback från testarna (14 nov)
--
-- Alla inloggade kan skicka. Ingen kan läsa i appen;
-- Hugo läser i Supabase (Table Editor → feedback).
-- ======================================================

create table public.feedback (
    id uuid primary key default gen_random_uuid(),
    author uuid default auth.uid() references public.profiles (id) on delete set null,
    author_name text not null default '',
    kind text not null check (kind in ('forslag', 'fel')),
    message text not null check (char_length(btrim(message)) between 1 and 2000),
    device text not null default '' check (char_length(device) <= 300),
    created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

create policy "feedback_insert_own" on public.feedback
for insert to authenticated
with check (author = (select auth.uid()));

-- Namnet sätts av databasen (så det går att läsa även om
-- kontot tas bort)
create or replace function public.feedback_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    new.author := auth.uid();
    new.author_name := coalesce((select p.name from public.profiles p where p.id = auth.uid()), '');
    new.message := btrim(new.message);
    new.created_at := now();
    return new;
end;
$$;

create trigger feedback_before_insert
before insert on public.feedback
for each row execute function public.feedback_before_insert();

revoke all on public.feedback from anon, authenticated;
grant insert (kind, message, device) on public.feedback to authenticated;
revoke execute on function public.feedback_before_insert() from public, anon, authenticated;
