-- Optional attribution for store and area profitability reports.
-- Expenses without an attribution remain company overhead.
alter table public.accounting_expenses
  add column if not exists store_id uuid references public.stores(id),
  add column if not exists area text;
create index if not exists accounting_expenses_store_id_idx
  on public.accounting_expenses(store_id) where store_id is not null;
