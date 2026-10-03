
-- Drop Off Operating System v2: branches, pricing, scans, shelves, permissions,
-- operational metrics, attachments, feature flags, API keys and generic audit.

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name text not null check (char_length(trim(name)) between 2 and 100),
  city text,
  active boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists branches_one_default on public.branches((is_default)) where is_default;
insert into public.branches(code,name,city,active,is_default)
select 'AMMAN','عمّان','Amman',true,true
where not exists(select 1 from public.branches);

alter table public.stores add column if not exists branch_id uuid references public.branches(id);
alter table public.orders add column if not exists branch_id uuid references public.branches(id);
alter table public.captains add column if not exists branch_id uuid references public.branches(id);
alter table public.sticker_rolls add column if not exists branch_id uuid references public.branches(id);
alter table public.warehouse_counts add column if not exists branch_id uuid references public.branches(id);
alter table public.orders add column if not exists service_type text not null default 'standard'
  check (service_type in ('standard','same_day','express','pickup_only','return'));
alter table public.orders add column if not exists pricing_rule_id uuid;
alter table public.area_rates add column if not exists latitude double precision;
alter table public.area_rates add column if not exists longitude double precision;

update public.stores set branch_id=(select id from public.branches where is_default limit 1) where branch_id is null;
update public.orders set branch_id=coalesce((select branch_id from public.stores s where s.id=orders.store_id),(select id from public.branches where is_default limit 1)) where branch_id is null;
update public.captains set branch_id=(select id from public.branches where is_default limit 1) where branch_id is null;
update public.sticker_rolls set branch_id=coalesce((select branch_id from public.stores s where s.id=sticker_rolls.store_id),(select id from public.branches where is_default limit 1)) where branch_id is null;
update public.warehouse_counts set branch_id=(select id from public.branches where is_default limit 1) where branch_id is null;

create or replace function public.set_default_branch() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.branch_id is null then
    select id into new.branch_id from public.branches where active and is_default limit 1;
  end if;
  return new;
end $$;
revoke all on function public.set_default_branch() from public,anon,authenticated;

do $$
declare t text;
begin
  foreach t in array array['stores','orders','captains','sticker_rolls','warehouse_counts'] loop
    execute format('drop trigger if exists set_default_branch on public.%I',t);
    execute format('create trigger set_default_branch before insert on public.%I for each row execute function public.set_default_branch()',t);
  end loop;
end $$;

create table if not exists public.profile_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission text not null check (permission ~ '^[a-z0-9_.-]{2,80}$'),
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key(user_id,permission)
);
create index if not exists profile_permissions_permission_idx on public.profile_permissions(permission,user_id);

create or replace function public.has_permission(p_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(
    public.current_user_role()='admin'
    or exists(select 1 from public.profile_permissions pp where pp.user_id=auth.uid() and pp.permission=p_permission),
    false
  )
$$;
revoke all on function public.has_permission(text) from public,anon;
grant execute on function public.has_permission(text) to authenticated;

create table if not exists public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references public.branches(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  area text,
  service_type text not null default 'standard'
    check (service_type in ('standard','same_day','express','pickup_only','return')),
  priority text check (priority is null or priority in ('normal','urgent')),
  min_parcels integer not null default 1 check(min_parcels between 1 and 100),
  max_parcels integer not null default 100 check(max_parcels between 1 and 100 and max_parcels>=min_parcels),
  delivery_fee numeric(12,2) not null check(delivery_fee>=0),
  return_fee numeric(12,2) not null default 0 check(return_fee>=0),
  active boolean not null default true,
  sort_order integer not null default 0,
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.orders
  drop constraint if exists orders_pricing_rule_id_fkey;
alter table public.orders
  add constraint orders_pricing_rule_id_fkey foreign key(pricing_rule_id) references public.pricing_rules(id) on delete set null;
create index if not exists pricing_rules_match_idx on public.pricing_rules(active,store_id,branch_id,service_type,lower(area),priority,min_parcels,max_parcels);

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
    and new.parcel_count between pr.min_parcels and pr.max_parcels
  order by
    ((pr.store_id is not null)::int + (pr.branch_id is not null)::int + (pr.area is not null)::int + (pr.priority is not null)::int) desc,
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
drop trigger if exists zzz_set_area_rate on public.orders;
drop trigger if exists zzz_apply_smart_pricing on public.orders;
create trigger zzz_apply_smart_pricing
before insert or update of store_id,branch_id,area,service_type,priority,parcel_count
on public.orders for each row execute function public.apply_smart_pricing();

create table if not exists public.warehouse_shelves (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  code text not null,
  zone text,
  capacity integer check(capacity is null or capacity>0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(branch_id,code)
);
create index if not exists warehouse_shelves_active_idx on public.warehouse_shelves(branch_id,active,code);

create table if not exists public.order_scans (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  scan_type text not null check(scan_type in ('pickup','warehouse_in','assign_shelf','warehouse_out','delivery','return_in','return_store','manual')),
  from_status text,
  to_status text,
  branch_id uuid references public.branches(id),
  shelf_id uuid references public.warehouse_shelves(id),
  actor_id uuid references public.profiles(id),
  captain_id uuid references public.captains(id),
  meta jsonb not null default '{}'::jsonb,
  scanned_at timestamptz not null default now()
);
create index if not exists order_scans_order_idx on public.order_scans(order_id,scanned_at desc);
create index if not exists order_scans_branch_idx on public.order_scans(branch_id,scanned_at desc);

create or replace function public.can_access_order(p_order_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.orders o
    where o.id=p_order_id and (
      public.current_user_role() in ('admin','accountant','warehouse')
      or public.is_store_member(o.store_id)
      or o.delivery_captain_id=auth.uid()
      or o.pickup_captain_id=auth.uid()
    )
  )
$$;
revoke all on function public.can_access_order(uuid) from public,anon;
grant execute on function public.can_access_order(uuid) to authenticated;

create or replace function public.scan_order_transition(p_code text,p_action text,p_shelf_code text default null)
returns public.orders language plpgsql security definer set search_path=public as $$
declare
  o public.orders;
  v_shelf public.warehouse_shelves;
  v_old text;
  v_new text;
  v_role public.user_role;
begin
  v_role:=public.current_user_role();
  if v_role is null then raise exception 'UNAUTHORIZED'; end if;

  select * into o
  from public.orders
  where order_code=trim(p_code) or qr_token::text=trim(p_code)
  limit 1;

  if o.id is null then
    select ord.* into o
    from public.order_stickers os join public.orders ord on ord.id=os.order_id
    where os.sticker_code=trim(p_code)
    limit 1;
  end if;
  if o.id is null then raise exception 'ORDER_NOT_FOUND'; end if;

  if v_role not in ('admin','warehouse') and not (
    (p_action in ('pickup','delivery') and (o.pickup_captain_id=auth.uid() or o.delivery_captain_id=auth.uid()))
  ) then raise exception 'NOT_ALLOWED'; end if;

  v_old:=o.status::text;
  v_new:=v_old;

  if p_shelf_code is not null and trim(p_shelf_code)<>'' then
    select * into v_shelf from public.warehouse_shelves
    where branch_id=o.branch_id and active and lower(code)=lower(trim(p_shelf_code))
    limit 1;
    if v_shelf.id is null then raise exception 'SHELF_NOT_FOUND'; end if;
  end if;

  case p_action
    when 'pickup' then null;
    when 'warehouse_in' then
      update public.orders set status='in_warehouse',received_at=coalesce(received_at,now()),
        shelf_location=coalesce(v_shelf.code,shelf_location),updated_at=now()
      where id=o.id returning * into o; v_new:=o.status::text;
    when 'assign_shelf' then
      if v_shelf.id is null then raise exception 'SHELF_REQUIRED'; end if;
      update public.orders set shelf_location=v_shelf.code,updated_at=now() where id=o.id returning * into o;
    when 'warehouse_out' then
      update public.orders set status=case when delivery_captain_id is null then 'assigned'::public.order_status else 'out_for_delivery'::public.order_status end,
        shelf_location=null,updated_at=now()
      where id=o.id returning * into o; v_new:=o.status::text;
    when 'delivery' then
      update public.orders set status='delivered',delivered_at=coalesce(delivered_at,now()),updated_at=now()
      where id=o.id returning * into o; v_new:=o.status::text;
    when 'return_in' then
      update public.orders set status='returned_warehouse',returned_at=coalesce(returned_at,now()),
        shelf_location=coalesce(v_shelf.code,shelf_location),updated_at=now()
      where id=o.id returning * into o; v_new:=o.status::text;
    when 'return_store' then
      update public.orders set status='returned_store',returned_at=coalesce(returned_at,now()),shelf_location=null,updated_at=now()
      where id=o.id returning * into o; v_new:=o.status::text;
    else
      if p_action<>'manual' then raise exception 'INVALID_ACTION'; end if;
  end case;

  insert into public.order_scans(order_id,scan_type,from_status,to_status,branch_id,shelf_id,actor_id,captain_id,meta)
  values(o.id,p_action,v_old,v_new,o.branch_id,v_shelf.id,auth.uid(),
    case when v_role in ('pickup_captain','delivery_captain') then auth.uid() else null end,
    jsonb_build_object('code',trim(p_code),'shelf_code',p_shelf_code));

  insert into public.order_events(order_id,event_type,old_status,new_status,actor_id,meta)
  values(o.id,'scan_'||p_action,
    case when v_old is null then null else v_old::public.order_status end,
    case when v_new is null then null else v_new::public.order_status end,
    auth.uid(),jsonb_build_object('shelf',coalesce(v_shelf.code,p_shelf_code)));

  return o;
end $$;
revoke all on function public.scan_order_transition(text,text,text) from public,anon;
grant execute on function public.scan_order_transition(text,text,text) to authenticated;

create table if not exists public.order_attachments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint check(size_bytes is null or size_bytes>=0),
  category text not null default 'other' check(category in ('paper','invoice','product','proof','other')),
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists order_attachments_order_idx on public.order_attachments(order_id,created_at desc);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('order-attachments','order-attachments',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create table if not exists public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null check(key ~ '^[a-z0-9_.-]{2,80}$'),
  store_id uuid references public.stores(id) on delete cascade,
  enabled boolean not null default true,
  description text,
  payload jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists feature_flags_unique_scope
on public.feature_flags(key,coalesce(store_id,'00000000-0000-0000-0000-000000000000'::uuid));

insert into public.feature_flags(key,enabled,description)
select x.key,true,x.description
from (values
 ('ai_order_photo','تحويل صورة الورقة إلى أوردر'),
 ('store_api','إنشاء الطلبات عبر API للمحلات'),
 ('smart_dispatch','اقتراح الكابتن تلقائياً'),
 ('attachments','مرفقات الأوردر'),
 ('offline_queue','طابور عمليات عند انقطاع الإنترنت'),
 ('ai_assistant','مساعد العمليات الذكي')
) as x(key,description)
where not exists(select 1 from public.feature_flags f where f.key=x.key and f.store_id is null);

create or replace function public.feature_enabled(p_key text,p_store_id uuid default null)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce(
    (select enabled from public.feature_flags
     where key=p_key and (store_id=p_store_id or store_id is null)
     order by (store_id is not null) desc limit 1),
    false
  )
$$;
revoke all on function public.feature_enabled(text,uuid) from public,anon;
grant execute on function public.feature_enabled(text,uuid) to authenticated;

create table if not exists public.store_api_keys (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  key_hash text not null unique,
  key_prefix text not null,
  label text,
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists store_api_keys_store_idx on public.store_api_keys(store_id,active);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  entity_table text not null,
  entity_id text,
  action text not null check(action in ('INSERT','UPDATE','DELETE')),
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);
create index if not exists audit_logs_entity_idx on public.audit_logs(entity_table,entity_id,created_at desc);
create index if not exists audit_logs_actor_idx on public.audit_logs(actor_id,created_at desc);

create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create or replace function private.log_dropoff_change() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id text;
begin
  if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then v_new:=to_jsonb(new); end if;
  v_id:=coalesce(v_new->>'id',v_old->>'id',v_new->>'order_id',v_old->>'order_id',v_new->>'user_id',v_old->>'user_id');
  insert into public.audit_logs(actor_id,entity_table,entity_id,action,old_data,new_data)
  values(auth.uid(),tg_table_name,v_id,tg_op,v_old,v_new);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.log_dropoff_change() from public,anon,authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'orders','stores','captains','captain_handovers','store_settlements',
    'accounting_expenses','order_exceptions','sticker_rolls','order_stickers',
    'pricing_rules','branches','warehouse_shelves','profile_permissions','feature_flags'
  ] loop
    execute format('drop trigger if exists dropoff_generic_audit on public.%I',t);
    execute format('create trigger dropoff_generic_audit after insert or update or delete on public.%I for each row execute function private.log_dropoff_change()',t);
  end loop;
end $$;

create or replace view public.area_performance_30d with (security_invoker=true) as
select
  lower(trim(area)) as area_key,
  max(area) as area,
  count(*) as total_orders,
  count(*) filter(where status='delivered') as delivered_orders,
  count(*) filter(where status in ('returned_store','returned_warehouse','rejected')) as problem_orders,
  round(avg(extract(epoch from (delivered_at-created_at))/3600) filter(where delivered_at is not null)::numeric,2) as avg_delivery_hours,
  coalesce(sum(delivery_fee) filter(where status='delivered'),0)::numeric(12,2) as fees_earned
from public.orders
where created_at>=now()-interval '30 days'
group by lower(trim(area));

create or replace view public.store_operational_metrics with (security_invoker=true) as
select
  s.id store_id,s.name,
  count(o.id) filter(where o.created_at>=now()-interval '30 days') as orders_30d,
  count(o.id) filter(where o.status='delivered' and o.created_at>=now()-interval '30 days') as delivered_30d,
  count(o.id) filter(where o.status in ('returned_store','returned_warehouse','rejected') and o.created_at>=now()-interval '30 days') as problem_30d,
  round(coalesce(100.0 * count(o.id) filter(where o.status='delivered' and o.created_at>=now()-interval '30 days')
    / nullif(count(o.id) filter(where o.created_at>=now()-interval '30 days'),0),0)::numeric,1) as delivery_rate,
  round(coalesce(avg(extract(epoch from (o.delivered_at-o.created_at))/3600) filter(where o.delivered_at is not null and o.created_at>=now()-interval '30 days'),0)::numeric,1) as avg_delivery_hours,
  greatest(0,least(100,round((
    coalesce(100.0*count(o.id) filter(where o.status='delivered' and o.created_at>=now()-interval '30 days')/
      nullif(count(o.id) filter(where o.created_at>=now()-interval '30 days'),0),0)*0.75
    + greatest(0,100-coalesce(avg(extract(epoch from (o.delivered_at-o.created_at))/3600) filter(where o.delivered_at is not null and o.created_at>=now()-interval '30 days'),24)*2)*0.25
  )::numeric,1))) as operational_index
from public.stores s left join public.orders o on o.store_id=s.id
group by s.id,s.name;

create or replace view public.captain_operational_metrics with (security_invoker=true) as
select
  c.id captain_id,p.full_name,c.daily_capacity,c.available_today,
  count(o.id) filter(where o.created_at>=now()-interval '30 days') as assigned_30d,
  count(o.id) filter(where o.status='delivered' and o.delivered_at>=now()-interval '30 days') as delivered_30d,
  count(o.id) filter(where o.status in ('returned_store','returned_warehouse','rejected') and o.created_at>=now()-interval '30 days') as problem_30d,
  count(o.id) filter(where o.status in ('assigned','out_for_delivery','postponed','no_answer')) as active_orders,
  round(coalesce(100.0*count(o.id) filter(where o.status='delivered' and o.delivered_at>=now()-interval '30 days')/
    nullif(count(o.id) filter(where o.created_at>=now()-interval '30 days'),0),0)::numeric,1) as delivery_rate,
  greatest(0,least(100,round((
    coalesce(100.0*count(o.id) filter(where o.status='delivered' and o.delivered_at>=now()-interval '30 days')/
      nullif(count(o.id) filter(where o.created_at>=now()-interval '30 days'),0),0)*0.8
    + greatest(0,100-(count(o.id) filter(where o.status in ('assigned','out_for_delivery','postponed','no_answer'))*5))*0.2
  )::numeric,1))) as operational_index
from public.captains c join public.profiles p on p.id=c.id
left join public.orders o on o.delivery_captain_id=c.id
group by c.id,p.full_name,c.daily_capacity,c.available_today;

create or replace function public.suggest_captains_for_order(p_order_id uuid)
returns table(
  captain_id uuid,full_name text,active_orders bigint,daily_capacity integer,
  area_affinity bigint,recommendation_score numeric
)
language sql stable security definer set search_path=public as $$
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
  limit 20
$$;
revoke all on function public.suggest_captains_for_order(uuid) from public,anon;
grant execute on function public.suggest_captains_for_order(uuid) to authenticated;

create or replace function public.refresh_order_exceptions()
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0;
begin
  if public.current_user_role() not in ('admin','warehouse') then raise exception 'NOT_ALLOWED'; end if;

  insert into public.order_exceptions(order_id,reason,next_action,created_by)
  select o.id,'بقي جديد أكثر من 6 ساعات','راجع المحل أو الاستلام',auth.uid()
  from public.orders o
  where o.status='new' and o.created_at<now()-interval '6 hours'
    and not exists(select 1 from public.order_exceptions e where e.order_id=o.id and e.resolved_at is null and e.reason='بقي جديد أكثر من 6 ساعات');
  get diagnostics v_count=row_count;

  insert into public.order_exceptions(order_id,reason,next_action,created_by)
  select o.id,'بقي بالمخزن أكثر من 24 ساعة','وزّع الطلب أو راجع سبب التأخير',auth.uid()
  from public.orders o
  where o.status='in_warehouse' and coalesce(o.received_at,o.updated_at)<now()-interval '24 hours'
    and not exists(select 1 from public.order_exceptions e where e.order_id=o.id and e.resolved_at is null and e.reason='بقي بالمخزن أكثر من 24 ساعة');
  v_count:=v_count+row_count;

  insert into public.order_exceptions(order_id,reason,next_action,created_by)
  select o.id,'مع الكابتن أكثر من 12 ساعة','تواصل مع الكابتن',auth.uid()
  from public.orders o
  where o.status in ('assigned','out_for_delivery','postponed','no_answer')
    and coalesce(o.assigned_at,o.updated_at)<now()-interval '12 hours'
    and not exists(select 1 from public.order_exceptions e where e.order_id=o.id and e.resolved_at is null and e.reason='مع الكابتن أكثر من 12 ساعة');
  v_count:=v_count+row_count;

  insert into public.order_exceptions(order_id,reason,next_action,created_by)
  select o.id,'رقم زبون مكرر خلال 72 ساعة لنفس المحل','تحقق أنه ليس طلباً مكرراً',auth.uid()
  from public.orders o
  where o.created_at>=now()-interval '72 hours'
    and o.status not in ('delivered','returned_store','cancelled')
    and exists(
      select 1 from public.orders x where x.store_id=o.store_id and x.customer_phone=o.customer_phone
        and x.id<>o.id and x.created_at>=now()-interval '72 hours'
        and x.status not in ('delivered','returned_store','cancelled')
    )
    and not exists(select 1 from public.order_exceptions e where e.order_id=o.id and e.resolved_at is null and e.reason='رقم زبون مكرر خلال 72 ساعة لنفس المحل');
  v_count:=v_count+row_count;

  return v_count;
end $$;
revoke all on function public.refresh_order_exceptions() from public,anon;
grant execute on function public.refresh_order_exceptions() to authenticated;

create or replace function public.validate_order_candidate(
  p_store_id uuid,p_customer_name text,p_customer_phone text,p_area text,p_address text,
  p_amount numeric,p_payment_type text,p_parcel_count integer
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare warnings jsonb:='[]'::jsonb; duplicates integer:=0;
begin
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
revoke all on function public.validate_order_candidate(uuid,text,text,text,text,numeric,text,integer) from public,anon;
grant execute on function public.validate_order_candidate(uuid,text,text,text,text,numeric,text,integer) to authenticated;

-- RLS and grants
alter table public.branches enable row level security;
alter table public.profile_permissions enable row level security;
alter table public.pricing_rules enable row level security;
alter table public.warehouse_shelves enable row level security;
alter table public.order_scans enable row level security;
alter table public.order_attachments enable row level security;
alter table public.feature_flags enable row level security;
alter table public.store_api_keys enable row level security;
alter table public.audit_logs enable row level security;

revoke all on public.branches,public.profile_permissions,public.pricing_rules,public.warehouse_shelves,
  public.order_scans,public.order_attachments,public.feature_flags,public.store_api_keys,public.audit_logs from anon;
grant select on public.branches,public.pricing_rules,public.warehouse_shelves,public.order_scans,public.order_attachments,public.feature_flags,public.audit_logs to authenticated;
grant select,insert,update,delete on public.profile_permissions,public.store_api_keys to authenticated;
grant insert,update,delete on public.pricing_rules,public.warehouse_shelves,public.feature_flags,public.order_attachments to authenticated;

drop policy if exists branches_read on public.branches;
create policy branches_read on public.branches for select to authenticated using (true);
drop policy if exists branches_admin on public.branches;
create policy branches_admin on public.branches for all to authenticated using (public.is_admin()) with check(public.is_admin());

drop policy if exists permissions_read on public.profile_permissions;
create policy permissions_read on public.profile_permissions for select to authenticated using (public.is_admin() or user_id=auth.uid());
drop policy if exists permissions_admin on public.profile_permissions;
create policy permissions_admin on public.profile_permissions for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists pricing_read on public.pricing_rules;
create policy pricing_read on public.pricing_rules for select to authenticated using(public.current_user_role() in ('admin','accountant','warehouse') or (store_id is not null and public.is_store_member(store_id)));
drop policy if exists pricing_admin on public.pricing_rules;
create policy pricing_admin on public.pricing_rules for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists shelves_staff_read on public.warehouse_shelves;
create policy shelves_staff_read on public.warehouse_shelves for select to authenticated using(public.current_user_role() in ('admin','warehouse','accountant'));
drop policy if exists shelves_admin_write on public.warehouse_shelves;
create policy shelves_admin_write on public.warehouse_shelves for all to authenticated using(public.current_user_role() in ('admin','warehouse')) with check(public.current_user_role() in ('admin','warehouse'));

drop policy if exists scans_read on public.order_scans;
create policy scans_read on public.order_scans for select to authenticated using(public.can_access_order(order_id));

drop policy if exists attachments_read on public.order_attachments;
create policy attachments_read on public.order_attachments for select to authenticated using(public.can_access_order(order_id));
drop policy if exists attachments_add on public.order_attachments;
create policy attachments_add on public.order_attachments for insert to authenticated with check(public.can_access_order(order_id) and uploaded_by=auth.uid());
drop policy if exists attachments_delete on public.order_attachments;
create policy attachments_delete on public.order_attachments for delete to authenticated using(public.current_user_role() in ('admin','warehouse') or uploaded_by=auth.uid());

drop policy if exists flags_read on public.feature_flags;
create policy flags_read on public.feature_flags for select to authenticated using(true);
drop policy if exists flags_admin on public.feature_flags;
create policy flags_admin on public.feature_flags for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists api_keys_admin on public.store_api_keys;
create policy api_keys_admin on public.store_api_keys for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists audit_read on public.audit_logs;
create policy audit_read on public.audit_logs for select to authenticated using(public.current_user_role() in ('admin','accountant'));

drop policy if exists order_files_select on storage.objects;
create policy order_files_select on storage.objects for select to authenticated using(
  bucket_id='order-attachments'
  and array_length(storage.foldername(name),1)>=1
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and public.can_access_order(((storage.foldername(name))[1])::uuid)
);
drop policy if exists order_files_insert on storage.objects;
create policy order_files_insert on storage.objects for insert to authenticated with check(
  bucket_id='order-attachments'
  and array_length(storage.foldername(name),1)>=1
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and public.can_access_order(((storage.foldername(name))[1])::uuid)
);
drop policy if exists order_files_delete on storage.objects;
create policy order_files_delete on storage.objects for delete to authenticated using(
  bucket_id='order-attachments'
  and array_length(storage.foldername(name),1)>=1
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and public.can_access_order(((storage.foldername(name))[1])::uuid)
);
