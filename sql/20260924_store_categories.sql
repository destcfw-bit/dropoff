-- A store can belong to several business categories.
alter table public.stores
  add column if not exists categories text[] not null default '{}'::text[];

alter table public.stores
  drop constraint if exists stores_categories_limit;

alter table public.stores
  add constraint stores_categories_limit
  check (cardinality(categories) <= 12);

create index if not exists stores_categories_gin
  on public.stores using gin (categories);

