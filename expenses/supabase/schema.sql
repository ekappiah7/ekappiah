-- ============================================================================
-- Family Ledger — Supabase schema
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
-- Safe to re-run: everything is idempotent.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- households

create table if not exists public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  currency    text not null default 'GHS',
  invite_code text not null unique,
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner','member','viewer')),
  display_name text not null default 'Member',
  person_id    uuid,
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Bypasses RLS on purpose so member policies can reference membership without
-- recursing into their own policy.
create or replace function public.my_household_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select household_id from public.household_members where user_id = auth.uid()
$$;

-- ------------------------------------------------------------- synced tables
-- Every synced table carries: household_id (the RLS tenant key), deleted
-- (tombstone — rows are never hard-deleted, so other devices learn about the
-- deletion on their next pull) and updated_at (the sync cursor).

create table if not exists public.people (
  id           uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  color        text,
  deleted      boolean not null default false,
  updated_at   timestamptz not null default now()
);

create table if not exists public.accounts (
  id              uuid primary key,
  household_id    uuid not null references public.households(id) on delete cascade,
  name            text not null,
  type            text not null default 'cash'
                  check (type in ('cash','momo','bank','savings','card','loan','other')),
  opening_balance bigint not null default 0,   -- minor units (pesewas)
  currency        text not null default 'GHS',
  archived        boolean not null default false,
  sort            integer not null default 0,
  deleted         boolean not null default false,
  updated_at      timestamptz not null default now()
);

create table if not exists public.categories (
  id           uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  flow         text not null check (flow in ('in','out')),
  parent_id    uuid references public.categories(id) on delete set null,
  essential    boolean not null default false,
  sort         integer not null default 0,
  deleted      boolean not null default false,
  updated_at   timestamptz not null default now()
);

create table if not exists public.transactions (
  id            uuid primary key,
  household_id  uuid not null references public.households(id) on delete cascade,
  kind          text not null check (kind in ('income','expense','transfer')),
  amount        bigint not null check (amount > 0),  -- always positive; kind carries direction
  fee           bigint not null default 0 check (fee >= 0),
  occurred_on   date not null,
  account_id    uuid references public.accounts(id) on delete set null,
  to_account_id uuid references public.accounts(id) on delete set null,
  category_id   uuid references public.categories(id) on delete set null,
  person_id     uuid references public.people(id) on delete set null,
  payee         text,
  note          text,
  tags          text[] not null default '{}',
  source        text not null default 'manual'
                check (source in ('manual','momo-sms','csv','recurring')),
  external_ref  text,                                -- e.g. MoMo transaction id, for dedupe
  created_by    uuid default auth.uid(),
  deleted       boolean not null default false,
  updated_at    timestamptz not null default now(),
  constraint transfer_shape check (
    (kind = 'transfer' and to_account_id is not null and category_id is null)
    or
    (kind <> 'transfer' and to_account_id is null)
  )
);

create table if not exists public.budgets (
  id           uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  category_id  uuid not null references public.categories(id) on delete cascade,
  month        date not null,                  -- always the 1st of the month
  amount       bigint not null check (amount >= 0),
  deleted      boolean not null default false,
  updated_at   timestamptz not null default now()
);

create table if not exists public.recurring_rules (
  id           uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  label        text not null,
  cadence      text not null check (cadence in ('weekly','biweekly','monthly','quarterly','termly','yearly')),
  next_on      date not null,
  ends_on      date,
  template     jsonb not null,                 -- a partial transaction
  deleted      boolean not null default false,
  updated_at   timestamptz not null default now()
);

-- --------------------------------------------------------------- constraints

create unique index if not exists budgets_unique_slot
  on public.budgets (household_id, category_id, month) where not deleted;

create unique index if not exists transactions_external_ref_unique
  on public.transactions (household_id, external_ref) where external_ref is not null and not deleted;

create index if not exists transactions_pull_idx on public.transactions (household_id, updated_at);
create index if not exists transactions_date_idx on public.transactions (household_id, occurred_on desc);
create index if not exists accounts_pull_idx   on public.accounts   (household_id, updated_at);
create index if not exists categories_pull_idx on public.categories (household_id, updated_at);
create index if not exists people_pull_idx     on public.people     (household_id, updated_at);
create index if not exists budgets_pull_idx    on public.budgets    (household_id, updated_at);
create index if not exists rules_pull_idx      on public.recurring_rules (household_id, updated_at);

-- ------------------------------------------------------------------ triggers
-- The server owns updated_at. Clients never set it, so the pull cursor is
-- monotonic in server time and last-write-to-reach-the-server wins.

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['people','accounts','categories','transactions','budgets','recurring_rules'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format(
      'create trigger touch_%1$s before insert or update on public.%1$s
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------- RLS

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.people            enable row level security;
alter table public.accounts          enable row level security;
alter table public.categories        enable row level security;
alter table public.transactions      enable row level security;
alter table public.budgets           enable row level security;
alter table public.recurring_rules   enable row level security;

drop policy if exists households_read on public.households;
create policy households_read on public.households
  for select using (id in (select public.my_household_ids()));

drop policy if exists households_write on public.households;
create policy households_write on public.households
  for update using (id in (select public.my_household_ids()))
  with check (id in (select public.my_household_ids()));

drop policy if exists members_read on public.household_members;
create policy members_read on public.household_members
  for select using (household_id in (select public.my_household_ids()));

-- One policy set per synced table: you may touch a row only while you are a
-- member of the household it belongs to.
do $$
declare t text;
begin
  foreach t in array array['people','accounts','categories','transactions','budgets','recurring_rules'] loop
    execute format('drop policy if exists %1$s_rw on public.%1$s', t);
    execute format(
      'create policy %1$s_rw on public.%1$s for all
       using (household_id in (select public.my_household_ids()))
       with check (household_id in (select public.my_household_ids()))', t);
  end loop;
end $$;

-- ------------------------------------------------------------------- RPC

create or replace function public.create_household(p_name text, p_currency text default 'GHS')
returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.households (name, currency, invite_code)
  values (p_name, coalesce(p_currency,'GHS'),
          upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 8)))
  returning * into h;
  insert into public.household_members (household_id, user_id, role, display_name)
  values (h.id, auth.uid(), 'owner', coalesce(auth.jwt() ->> 'email', 'Owner'));
  return h;
end $$;

create or replace function public.join_household(p_code text, p_display_name text default null)
returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into h from public.households where invite_code = upper(trim(p_code));
  if h.id is null then raise exception 'no household with that invite code'; end if;
  insert into public.household_members (household_id, user_id, role, display_name)
  values (h.id, auth.uid(), 'member',
          coalesce(nullif(trim(p_display_name),''), auth.jwt() ->> 'email', 'Member'))
  on conflict (household_id, user_id) do nothing;
  return h;
end $$;

create or replace function public.my_households()
returns table (id uuid, name text, currency text, invite_code text, role text)
language sql security definer stable set search_path = public as $$
  select h.id, h.name, h.currency, h.invite_code, m.role
  from public.households h
  join public.household_members m on m.household_id = h.id
  where m.user_id = auth.uid()
$$;

grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text)   to authenticated;
grant execute on function public.my_households()              to authenticated;
