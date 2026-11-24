-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query).

create table if not exists public.documents (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  version     integer     not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists documents_collection_updated on public.documents (collection, updated_at);

create table if not exists public.credentials (
  id          text primary key,                       -- employee ID, or 'admin'
  role        text not null check (role in ('admin','staff')),
  username    text,                                   -- admin only
  algo        text not null default 'scrypt',         -- scrypt | sha256 (legacy import)
  salt        text not null,
  hash        text not null,
  updated_at  timestamptz not null default now()
);

-- Only the server (service role key) may touch these tables.
-- Row level security is switched on with no policies, so the public anon key can read nothing.
alter table public.documents   enable row level security;
alter table public.credentials enable row level security;
