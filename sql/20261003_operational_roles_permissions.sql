
-- Operational staff roles and least-privilege access model.

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.profiles p
    where p.id=(select auth.uid()) and p.active and p.role in ('owner','admin')
  )
$$;

create or replace function public.is_admin(uid uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.profiles p
    where p.id=uid and p.active and p.role in ('owner','admin')
  )
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.profiles p
    where p.id=(select auth.uid()) and p.active
      and p.role in ('owner','admin','manager','warehouse','dispatcher')
  )
$$;

create or replace function public.finance_access()
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(public.current_user_role() in ('owner','admin','accountant'),false)
$$;

create or replace function public.can_access_order(p_order_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.orders o
    where o.id=p_order_id and (
      public.current_user_role() in ('owner','admin','manager','accountant','warehouse','support','dispatcher')
      or public.is_store_member(o.store_id)
      or o.delivery_captain_id=(select auth.uid())
      or o.pickup_captain_id=(select auth.uid())
    )
  )
$$;

-- Support is read-mostly: can inspect operational data and resolve exception tickets.
drop policy if exists orders_support_read on public.orders;
create policy orders_support_read on public.orders for select to authenticated
using(public.current_user_role()='support');

drop policy if exists stores_support_read on public.stores;
create policy stores_support_read on public.stores for select to authenticated
using(public.current_user_role()='support');

drop policy if exists profiles_support_read on public.profiles;
create policy profiles_support_read on public.profiles for select to authenticated
using(public.current_user_role()='support');

drop policy if exists captains_support_read on public.captains;
create policy captains_support_read on public.captains for select to authenticated
using(public.current_user_role()='support');

drop policy if exists order_events_support_read on public.order_events;
create policy order_events_support_read on public.order_events for select to authenticated
using(public.current_user_role()='support');

drop policy if exists exceptions_support_read on public.order_exceptions;
create policy exceptions_support_read on public.order_exceptions for select to authenticated
using(public.current_user_role()='support');

drop policy if exists exceptions_support_update on public.order_exceptions;
create policy exceptions_support_update on public.order_exceptions for update to authenticated
using(public.current_user_role()='support')
with check(public.current_user_role()='support');

-- Manager can maintain store/captain operational settings without user/security administration.
drop policy if exists stores_manager_update on public.stores;
create policy stores_manager_update on public.stores for update to authenticated
using(public.current_user_role()='manager')
with check(public.current_user_role()='manager');

drop policy if exists captains_manager_update on public.captains;
create policy captains_manager_update on public.captains for update to authenticated
using(public.current_user_role()='manager')
with check(public.current_user_role()='manager');

create or replace function public.suggest_captains_for_order(p_order_id uuid)
returns table(
  captain_id uuid,full_name text,active_orders bigint,daily_capacity integer,
  area_affinity bigint,recommendation_score numeric
)
language plpgsql stable security definer set search_path=public as $$
begin
  if public.current_user_role() not in ('owner','admin','manager','warehouse','dispatcher','accountant') then
    raise exception 'NOT_ALLOWED';
  end if;
  return query
  with target as (
    select id,area,branch_id from public.orders where id=p_order_id
  ), metrics as (
    select c.id,p.full_name,c.daily_capacity,
      count(o.id) filter(where o.status in ('assigned','out_for_delivery','postponed','no_answer')) as active_orders,
      count(o.id) filter(where o.status='delivered' and lower(trim(o.area))=lower(trim(t.area)) and o.delivered_at>=now()-interval '30 days') as area_affinity
    from public.captains c
    join public.profiles p on p.id=c.id
    cross join target t
    left join public.orders o on o.delivery_captain_id=c.id
    where c.active and c.available_today and p.active
      and c.captain_type in ('delivery','both')
      and (c.branch_id=t.branch_id or c.branch_id is null)
    group by c.id,p.full_name,c.daily_capacity
  )
  select id,full_name,active_orders,daily_capacity,area_affinity,
    round((100 - least(95,(active_orders::numeric/greatest(daily_capacity,1))*100) + least(30,area_affinity*3))::numeric,1)
  from metrics
  order by 6 desc,active_orders asc,full_name
  limit 20;
end $$;

create or replace function public.validate_order_candidate(
  p_store_id uuid,p_customer_name text,p_customer_phone text,p_area text,p_address text,
  p_amount numeric,p_payment_type text,p_parcel_count integer
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare warnings jsonb:='[]'::jsonb; duplicates integer:=0;
begin
  if public.current_user_role() not in ('owner','admin','manager','warehouse','dispatcher','support','accountant','store_owner')
    or (public.current_user_role()='store_owner' and not public.is_store_member(p_store_id)) then
    raise exception 'NOT_ALLOWED';
  end if;
  if length(trim(coalesce(p_customer_name,'')))<2 then warnings:=warnings||jsonb_build_array('اسم الزبون قصير أو ناقص'); end if;
  if trim(coalesce(p_customer_phone,'')) !~ '^(\+9627|07|7)[0-9]{8}$' then warnings:=warnings||jsonb_build_array('راجع رقم الهاتف الأردني'); end if;
  if length(trim(coalesce(p_area,'')))<2 then warnings:=warnings||jsonb_build_array('المنطقة ناقصة'); end if;
  if length(trim(coalesce(p_address,'')))<4 then warnings:=warnings||jsonb_build_array('العنوان يحتاج تفاصيل أكثر'); end if;
  if p_payment_type='cod' and coalesce(p_amount,0)=0 then warnings:=warnings||jsonb_build_array('طلب تحصيل بمبلغ صفر'); end if;
  if coalesce(p_amount,0)>500 then warnings:=warnings||jsonb_build_array('مبلغ التحصيل مرتفع؛ راجعه'); end if;
  if coalesce(p_parcel_count,0)<1 or p_parcel_count>100 then warnings:=warnings||jsonb_build_array('عدد القطع غير صحيح'); end if;

  select count(*) into duplicates from public.orders
  where store_id=p_store_id and customer_phone=p_customer_phone and created_at>=now()-interval '72 hours'
    and status not in ('delivered','returned_store','cancelled');

  if duplicates>0 then warnings:=warnings||jsonb_build_array('يوجد طلب نشط لنفس الرقم خلال آخر 72 ساعة'); end if;
  return jsonb_build_object('ok',jsonb_array_length(warnings)=0,'warnings',warnings,'duplicate_count',duplicates);
end $$;

create or replace function public.ops_command_search(p_query text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare q text:=trim(coalesce(p_query,'')); result jsonb;
begin
  if public.current_user_role() not in ('owner','admin','manager','accountant','warehouse','support','dispatcher') then raise exception 'NOT_ALLOWED'; end if;
  if length(q)<2 then return jsonb_build_object('orders','[]'::jsonb,'stores','[]'::jsonb,'people','[]'::jsonb); end if;

  select jsonb_build_object(
    'orders',coalesce((
      select jsonb_agg(x) from (
        select id,order_code,customer_name,customer_phone,area,status,store_id,created_at
        from public.orders
        where order_code ilike '%'||q||'%' or customer_phone ilike '%'||q||'%' or customer_name ilike '%'||q||'%' or area ilike '%'||q||'%'
        order by created_at desc limit 12
      ) x
    ),'[]'::jsonb),
    'stores',coalesce((
      select jsonb_agg(x) from (
        select id,name,phone,address,active from public.stores
        where name ilike '%'||q||'%' or coalesce(phone,'') ilike '%'||q||'%' or coalesce(address,'') ilike '%'||q||'%'
        order by name limit 8
      ) x
    ),'[]'::jsonb),
    'people',coalesce((
      select jsonb_agg(x) from (
        select id,full_name,phone,username,role,active from public.profiles
        where coalesce(full_name,'') ilike '%'||q||'%' or coalesce(phone,'') ilike '%'||q||'%' or coalesce(username,'') ilike '%'||q||'%'
        order by created_at desc limit 8
      ) x
    ),'[]'::jsonb)
  ) into result;
  return result;
end $$;

create or replace function public.system_health_status()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
  select jsonb_build_object(
    'database',true,
    'orders',(select count(*) from public.orders),
    'stores',(select count(*) from public.stores where active),
    'captains',(select count(*) from public.captains where active),
    'open_exceptions',(select count(*) from public.order_exceptions where resolved_at is null),
    'last_backup',(select max(created_at) from public.backup_snapshots),
    'last_accounting_close',(select max(closed_at) from public.accounting_closures),
    'features',(select jsonb_object_agg(key,enabled) from public.feature_flags where store_id is null)
  ) into r;
  return r;
end $$;

create or replace function public.create_daily_snapshot(p_date date default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  d date:=coalesce(p_date,(now() at time zone 'Asia/Amman')::date);
  v_id uuid;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;

  insert into public.backup_snapshots(snapshot_date,snapshot,created_by)
  values(
    d,
    jsonb_build_object(
      'generated_at',now(),
      'branches',coalesce((select jsonb_agg(to_jsonb(x)) from public.branches x),'[]'::jsonb),
      'stores',coalesce((select jsonb_agg(to_jsonb(x)) from public.stores x),'[]'::jsonb),
      'store_users',coalesce((select jsonb_agg(to_jsonb(x)) from public.store_users x),'[]'::jsonb),
      'captains',coalesce((select jsonb_agg(to_jsonb(x)) from public.captains x),'[]'::jsonb),
      'orders',coalesce((select jsonb_agg(to_jsonb(x)) from public.orders x),'[]'::jsonb),
      'order_events',coalesce((select jsonb_agg(to_jsonb(x)) from public.order_events x where x.created_at>=now()-interval '90 days'),'[]'::jsonb),
      'handovers',coalesce((select jsonb_agg(to_jsonb(x)) from public.captain_handovers x),'[]'::jsonb),
      'store_settlements',coalesce((select jsonb_agg(to_jsonb(x)) from public.store_settlements x),'[]'::jsonb),
      'pricing_rules',coalesce((select jsonb_agg(to_jsonb(x)) from public.pricing_rules x),'[]'::jsonb),
      'shelves',coalesce((select jsonb_agg(to_jsonb(x)) from public.warehouse_shelves x),'[]'::jsonb),
      'sticker_rolls',coalesce((select jsonb_agg(to_jsonb(x)) from public.sticker_rolls x),'[]'::jsonb),
      'order_stickers',coalesce((select jsonb_agg(to_jsonb(x)) from public.order_stickers x),'[]'::jsonb),
      'feature_flags',coalesce((select jsonb_agg(to_jsonb(x)) from public.feature_flags x),'[]'::jsonb),
      'profile_permissions',coalesce((select jsonb_agg(to_jsonb(x)) from public.profile_permissions x),'[]'::jsonb)
    ),
    auth.uid()
  )
  on conflict(snapshot_date) do update set snapshot=excluded.snapshot,created_at=now(),created_by=excluded.created_by
  returning id into v_id;

  delete from public.backup_snapshots where snapshot_date<d-14;
  return v_id;
end $$;
