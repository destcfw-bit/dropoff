
drop policy if exists orders_support_update on public.orders;
create policy orders_support_update on public.orders for update to authenticated
using(public.current_user_role()='support')
with check(public.current_user_role()='support');
