-- The accountant's cash is recorded when staff accepts a captain handover.
-- Daily closings are immutable snapshots; later corrections remain visible in the live ledger.
create table if not exists public.accounting_expenses (
  id uuid primary key default gen_random_uuid(),
  amount numeric(12,2) not null check (amount > 0),
  method text not null default 'cash' check (method in ('cash','bank')),
  category text not null check (category in ('salary','fuel','warehouse','other')),
  note text not null default '',
  spent_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.accounting_closures (
  id uuid primary key default gen_random_uuid(),
  business_date date not null unique,
  orders_cash numeric(12,2) not null,
  handovers_cash numeric(12,2) not null,
  store_payouts numeric(12,2) not null,
  expenses numeric(12,2) not null,
  fees_earned numeric(12,2) not null,
  captain_outstanding numeric(12,2) not null,
  accountant_cash numeric(12,2) not null,
  counted_cash numeric(12,2) not null check (counted_cash >= 0),
  cash_shortage numeric(12,2) not null,
  operating_profit numeric(12,2) not null,
  closed_by uuid not null default auth.uid() references public.profiles(id),
  closed_at timestamptz not null default now()
);

create index if not exists accounting_expenses_spent_at_idx on public.accounting_expenses(spent_at);
create index if not exists accounting_expenses_created_by_idx on public.accounting_expenses(created_by);
create index if not exists accounting_closures_closed_by_idx on public.accounting_closures(closed_by);
alter table public.accounting_expenses enable row level security;
alter table public.accounting_closures enable row level security;
revoke all on public.accounting_expenses,public.accounting_closures from public,anon;
grant select,insert on public.accounting_expenses,public.accounting_closures to authenticated;

create policy accounting_expenses_read on public.accounting_expenses for select to authenticated using (public.is_admin());
create policy accounting_expenses_add on public.accounting_expenses for insert to authenticated with check (public.is_admin() and created_by=(select auth.uid()));
create policy accounting_closures_read on public.accounting_closures for select to authenticated using (public.is_admin());
create policy accounting_closures_add on public.accounting_closures for insert to authenticated with check (public.is_admin() and closed_by=(select auth.uid()));

create or replace function public.accounting_overview(p_day date)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_day is null then raise exception 'INVALID_DATE'; end if;
  with daily_orders as (
    select coalesce(sum(amount_to_collect) filter (where status='delivered' and payment_type='cod'
      and (delivered_at at time zone 'Asia/Amman')::date=p_day),0) as orders_cash,
      coalesce(sum(delivery_fee) filter (where status='delivered'
      and (delivered_at at time zone 'Asia/Amman')::date=p_day),0)
      +coalesce(sum(return_fee) filter (where status='returned_store'
      and (returned_at at time zone 'Asia/Amman')::date=p_day),0) as fees
    from public.orders
    where (delivered_at at time zone 'Asia/Amman')::date=p_day or (returned_at at time zone 'Asia/Amman')::date=p_day
  ), daily_handovers as (
    select coalesce(sum(amount),0) as cash from public.captain_handovers
    where (handed_over_at at time zone 'Asia/Amman')::date=p_day and coalesce(method,'cash')='cash'
  ), daily_payouts as (
    select coalesce(sum(amount),0) as cash from public.store_settlements
    where (created_at at time zone 'Asia/Amman')::date=p_day and coalesce(method,'cash')='cash'
  ), daily_expenses as (
    select coalesce(sum(amount),0) as total from public.accounting_expenses
    where (spent_at at time zone 'Asia/Amman')::date=p_day
  ), outstanding as (
    select coalesce(sum(cash_due),0) as total from public.captain_cash_summary
  ), company_cash as (
    select (select coalesce(sum(amount),0) from public.captain_handovers where coalesce(method,'cash')='cash')
      -(select coalesce(sum(amount),0) from public.store_settlements where coalesce(method,'cash')='cash')
      -(select coalesce(sum(amount),0) from public.accounting_expenses where method='cash') as total
  )
  select jsonb_build_object('orders_cash',d.orders_cash,'handovers_cash',h.cash,
    'store_payouts',s.cash,'expenses',e.total,'fees_earned',d.fees,
    'captain_outstanding',o.total,'accountant_cash',c.total,'operating_profit',d.fees-e.total)
  into result from daily_orders d cross join daily_handovers h cross join daily_payouts s
    cross join daily_expenses e cross join outstanding o cross join company_cash c;
  return result;
end $$;
revoke all on function public.accounting_overview(date) from public,anon;
grant execute on function public.accounting_overview(date) to authenticated;

create or replace function public.close_accounting_day(p_day date,p_counted_cash numeric)
returns public.accounting_closures language plpgsql security invoker set search_path=public as $$
declare result public.accounting_closures;
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_day is null or p_day <> (now() at time zone 'Asia/Amman')::date then raise exception 'INVALID_DATE'; end if;
  if p_counted_cash is null or p_counted_cash < 0 then raise exception 'INVALID_CASH_COUNT'; end if;

  with daily_orders as (
    select coalesce(sum(amount_to_collect) filter (where status='delivered' and payment_type='cod'
      and (delivered_at at time zone 'Asia/Amman')::date=p_day),0) as cash,
      coalesce(sum(delivery_fee) filter (where status='delivered'
      and (delivered_at at time zone 'Asia/Amman')::date=p_day),0)
      +coalesce(sum(return_fee) filter (where status='returned_store'
      and (returned_at at time zone 'Asia/Amman')::date=p_day),0) as fees
    from public.orders
    where (delivered_at at time zone 'Asia/Amman')::date=p_day or (returned_at at time zone 'Asia/Amman')::date=p_day
  ), daily_handovers as (
    select coalesce(sum(amount),0) as amount from public.captain_handovers
    where (handed_over_at at time zone 'Asia/Amman')::date=p_day and coalesce(method,'cash')='cash'
  ), daily_payouts as (
    select coalesce(sum(amount),0) as amount from public.store_settlements
    where (created_at at time zone 'Asia/Amman')::date=p_day and coalesce(method,'cash')='cash'
  ), daily_expenses as (
    select coalesce(sum(amount),0) as amount from public.accounting_expenses
    where (spent_at at time zone 'Asia/Amman')::date=p_day
  ), outstanding as (
    select coalesce(sum(cash_due),0) as amount from public.captain_cash_summary
  ), company_cash as (
    select (select coalesce(sum(amount),0) from public.captain_handovers where coalesce(method,'cash')='cash')
      -(select coalesce(sum(amount),0) from public.store_settlements where coalesce(method,'cash')='cash')
      -(select coalesce(sum(amount),0) from public.accounting_expenses where method='cash') as amount
  )
  insert into public.accounting_closures
    (business_date,orders_cash,handovers_cash,store_payouts,expenses,fees_earned,
     captain_outstanding,accountant_cash,counted_cash,cash_shortage,operating_profit)
  select p_day,d.cash,h.amount,s.amount,e.amount,d.fees,o.amount,c.amount,
    p_counted_cash,c.amount-p_counted_cash,d.fees-e.amount
  from daily_orders d cross join daily_handovers h cross join daily_payouts s
  cross join daily_expenses e cross join outstanding o cross join company_cash c
  on conflict (business_date) do nothing
  returning * into result;
  if result.id is null then raise exception 'DAY_ALREADY_CLOSED'; end if;
  return result;
end $$;
revoke all on function public.close_accounting_day(date,numeric) from public,anon;
grant execute on function public.close_accounting_day(date,numeric) to authenticated;
