-- Store orders receive the existing database-generated order number.
-- The QR encodes that order number; only signed-in users with order access can see its details.
create or replace function public.store_create_order_auto(
  p_store_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_area text,
  p_address text,
  p_amount_to_collect numeric default 0,
  p_payment_type text default 'cod',
  p_parcel_count integer default 1,
  p_priority text default 'normal',
  p_notes text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare v_order public.orders;
begin
  if (select auth.uid()) is null or public.current_user_role() is distinct from 'store_owner'::public.user_role then
    raise exception 'STORE_ACCOUNT_REQUIRED';
  end if;
  if p_store_id is null or not public.is_store_member(p_store_id)
    or not exists (select 1 from public.stores where id = p_store_id and active) then
    raise exception 'STORE_NOT_AVAILABLE';
  end if;
  if nullif(btrim(p_customer_name),'') is null or nullif(btrim(p_customer_phone),'') is null
    or nullif(btrim(p_area),'') is null or nullif(btrim(p_address),'') is null
    or length(p_customer_name)>150 or length(p_customer_phone)>40
    or length(p_area)>150 or length(p_address)>500 or length(coalesce(p_notes,''))>2000 then
    raise exception 'INVALID_ORDER_DETAILS';
  end if;
  if p_payment_type not in ('cod','prepaid') or p_parcel_count not between 1 and 100
    or p_priority not in ('normal','urgent') or p_amount_to_collect is null
    or p_amount_to_collect < 0 or p_amount_to_collect > 100000 then
    raise exception 'INVALID_ORDER_OPTIONS';
  end if;

  insert into public.orders (
    store_id,customer_name,customer_phone,area,address,
    amount_to_collect,payment_type,parcel_count,priority,notes,status,created_by
  ) values (
    p_store_id,btrim(p_customer_name),btrim(p_customer_phone),btrim(p_area),btrim(p_address),
    case when p_payment_type='prepaid' then 0 else p_amount_to_collect end,
    p_payment_type,p_parcel_count,p_priority,nullif(btrim(p_notes),''),'new',auth.uid()
  ) returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.store_create_order_auto(uuid,text,text,text,text,numeric,text,integer,text,text) from public,anon;
grant execute on function public.store_create_order_auto(uuid,text,text,text,text,numeric,text,integer,text,text) to authenticated;
