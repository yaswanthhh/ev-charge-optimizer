create table if not exists sites (
  id serial primary key,
  name text not null,
  max_kw numeric not null
);

create table if not exists runs (
  id serial primary key,
  created_at timestamptz not null default now(),
  input jsonb not null,
  output jsonb not null
);
