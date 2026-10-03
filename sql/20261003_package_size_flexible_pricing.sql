
-- Package size dimension for flexible pricing.
alter table public.orders
  add column if not exists package_size text not null default 'medium'
  check (package_size in ('small','medium','large','xl'));

alter table public.pricing_rules
  add column if not exists package_size text
  check (package_size is null or package_size in ('small','medium','large','xl'));

drop index if exists public.pricing_rules_match_idx;
create index pricing_rules_match_idx on public.pricing_rules(
  active,store_id,branch_id,service_type,lower(area),priority,package_size,min_parcels,max_parcels
);

create or replace function public.apply_smart_pricing() returns trigger
language plpgsql set search_path=public as $$
declare
  r public.pricing_rules;
  v_fee numeric;
  v_return numeric;
begin
  select * into r
  from public.pricing_rules pr
  where pr.active
    and (pr.store_id is null or pr.store_id=new.store_id)
    and (pr.branch_id is null or pr.branch_id=new.branch_id)
    and pr.service_type=new.service_type
    and (pr.area is null or lower(trim(pr.area))=lower(trim(new.area)))
    and (pr.priority is null or pr.priority=new.priority)
    and (pr.package_size is null or pr.package_size=new.package_size)
    and new.parcel_count between pr.min_parcels and pr.max_parcels
  order by
    ((pr.store_id is not null)::int + (pr.branch_id is not null)::int + (pr.area is not null)::int
      + (pr.priority is not null)::int + (pr.package_size is not null)::int) desc,
    pr.sort_order desc, pr.created_at desc
  limit 1;

  if found then
    new.delivery_fee:=r.delivery_fee;
    new.return_fee:=r.return_fee;
    new.pricing_rule_id:=r.id;
    return new;
  end if;

  select ar.delivery_fee into v_fee
  from public.area_rates ar
  where lower(trim(ar.area))=lower(trim(new.area))
    and (ar.store_id=new.store_id or ar.store_id is null)
  order by (ar.store_id is not null) desc
  limit 1;

  select s.return_fee, coalesce(v_fee,s.delivery_fee)
    into v_return,v_fee
  from public.stores s where s.id=new.store_id;

  new.delivery_fee:=coalesce(v_fee,0);
  new.return_fee:=coalesce(v_return,0);
  new.pricing_rule_id:=null;
  return new;
end $$;

drop trigger if exists zzz_apply_smart_pricing on public.orders;
create trigger zzz_apply_smart_pricing
before insert or update of store_id,branch_id,area,service_type,priority,package_size,parcel_count
on public.orders for each row execute function public.apply_smart_pricing();

create or replace function public.store_create_order_auto_v3(
  p_store_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_area text,
  p_address text,
  p_amount_to_collect numeric default 0,
  p_payment_type text default 'cod',
  p_parcel_count integer default 1,
  p_priority text default 'normal',
  p_notes text default null,
  p_service_type text default 'standard',
  p_package_size text default 'medium'
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
    or p_amount_to_collect < 0 or p_amount_to_collect > 100000
    or p_service_type not in ('standard','same_day','express','pickup_only','return')
    or p_package_size not in ('small','medium','large','xl') then
    raise exception 'INVALID_ORDER_OPTIONS';
  end if;

  insert into public.orders (
    store_id,customer_name,customer_phone,area,address,
    amount_to_collect,payment_type,parcel_count,priority,notes,status,created_by,service_type,package_size
  ) values (
    p_store_id,btrim(p_customer_name),btrim(p_customer_phone),btrim(p_area),btrim(p_address),
    case when p_payment_type='prepaid' then 0 else p_amount_to_collect end,
    p_payment_type,p_parcel_count,p_priority,nullif(btrim(p_notes),''),'new',auth.uid(),p_service_type,p_package_size
  ) returning * into v_order;
  return v_order;
end;
$$;
revoke all on function public.store_create_order_auto_v3(uuid,text,text,text,text,numeric,text,integer,text,text,text,text) from public,anon;
grant execute on function public.store_create_order_auto_v3(uuid,text,text,text,text,numeric,text,integer,text,text,text,text) to authenticated;
