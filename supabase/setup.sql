-- Card Ledger cloud sync: run this ONCE in your Supabase project.
-- Supabase dashboard -> SQL Editor -> New query -> paste all of this -> Run.
--
-- Each row is one item (with its sales inside `data`). Row Level Security means a signed-in user
-- can only ever see and change their own rows, which is what makes it safe for the app's
-- public "anon" key to live in the website's code.

create table if not exists public.ledger_items (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,          -- the item (name, qty, prices, sales, photo...)
  updated_at bigint not null,                             -- when the device last changed it (ms); newest wins
  deleted    boolean not null default false,              -- deleted items stay as a marker so other devices remove them too
  synced_at  timestamptz not null default clock_timestamp() -- when the cloud last changed it; devices fetch "everything since..."
);

create index if not exists ledger_items_user_synced_idx on public.ledger_items (user_id, synced_at);

alter table public.ledger_items enable row level security;

drop policy if exists "Users manage their own items" on public.ledger_items;
create policy "Users manage their own items" on public.ledger_items
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Keeps the cloud copy sane:
--  * ignores a write that is older than what's already stored (a device that was offline for a while)
--  * stamps synced_at itself, and never lets a row change owner
create or replace function public.ledger_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    if new.updated_at <= old.updated_at then
      return null;  -- stale write: skip it
    end if;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists ledger_items_guard on public.ledger_items;
create trigger ledger_items_guard
  before insert or update on public.ledger_items
  for each row execute function public.ledger_items_guard();
