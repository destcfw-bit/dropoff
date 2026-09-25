-- Accountant can read financial inputs and post handovers/settlements/expenses.
-- Only admins may create or edit user accounts, assign orders or change order data.
create or replace function public.finance_access() returns boolean
language sql stable security invoker set search_path=public as $$
  select coalesce(public.current_user_role() in ('admin','accountant'),false)
$$;
revoke all on function public.finance_access() from public,anon;
grant execute on function public.finance_access() to authenticated;

create policy profiles_accountant_read on public.profiles for select to authenticated using (public.current_user_role()='accountant');
create policy captains_accountant_read on public.captains for select to authenticated using (public.current_user_role()='accountant');
create policy stores_accountant_read on public.stores for select to authenticated using (public.current_user_role()='accountant');
create policy orders_accountant_read on public.orders for select to authenticated using (public.current_user_role()='accountant');
create policy handovers_accountant_read on public.captain_handovers for select to authenticated using (public.current_user_role()='accountant');
create policy settlements_accountant_read on public.store_settlements for select to authenticated using (public.current_user_role()='accountant');
create policy handovers_accountant_add on public.captain_handovers for insert to authenticated with check (public.current_user_role()='accountant' and created_by=(select auth.uid()));
create policy settlements_accountant_add on public.store_settlements for insert to authenticated with check (public.current_user_role()='accountant' and created_by=(select auth.uid()));
-- Store owners can see public area rates before creating an order.
alter policy area_rates_read on public.area_rates using (public.is_staff() or (store_id is not null and public.is_store_member(store_id)) or (store_id is null and public.current_user_role()='store_owner'));

drop policy accounting_expenses_read on public.accounting_expenses;
drop policy accounting_expenses_add on public.accounting_expenses;
drop policy accounting_closures_read on public.accounting_closures;
drop policy accounting_closures_add on public.accounting_closures;
create policy accounting_expenses_read on public.accounting_expenses for select to authenticated using (public.finance_access());
create policy accounting_expenses_add on public.accounting_expenses for insert to authenticated with check (public.finance_access() and created_by=(select auth.uid()));
create policy accounting_closures_read on public.accounting_closures for select to authenticated using (public.finance_access());
create policy accounting_closures_add on public.accounting_closures for insert to authenticated with check (public.finance_access() and closed_by=(select auth.uid()));

-- The previously deployed invoker functions already enforce is_admin() internally.
-- Change only that check; retain the original atomic financial calculations.
do $$
declare signature text; definition text;
begin
  foreach signature in array array['public.accounting_overview(date)', 'public.close_accounting_day(date,numeric)'] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if position('if not public.is_admin() then' in definition)=0 then
      raise exception 'Unexpected financial function definition: %',signature;
    end if;
    execute replace(definition,'if not public.is_admin() then','if not public.finance_access() then');
  end loop;
end $$;
