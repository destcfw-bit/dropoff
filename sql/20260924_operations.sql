-- Drop Off operations. Apply once to the existing Supabase project.
alter table public.orders
  add column if not exists payment_type text not null default 'cod' check (payment_type in ('cod','prepaid')),
  add column if not exists parcel_count integer not null default 1 check (parcel_count between 1 and 100),
  add column if not exists priority text not null default 'normal' check (priority in ('normal','urgent')),
  add column if not exists promised_at timestamptz,
  add column if not exists delivery_run text not null default 'evening' check (delivery_run in ('morning','evening')),
  add column if not exists exception_reason text,
  add column if not exists exception_owner uuid references public.profiles(id),
  add column if not exists exception_resolved_at timestamptz;
alter table public.order_batches
  add column if not exists received_count integer not null default 0 check (received_count >= 0),
  add column if not exists received_at timestamptz;
alter table public.captains
  add column if not exists daily_capacity integer not null default 30 check (daily_capacity between 1 and 500),
  add column if not exists available_today boolean not null default true;

create table if not exists public.area_rates (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete cascade,
  area text not null,
  delivery_fee numeric(12,2) not null check (delivery_fee >= 0),
  created_at timestamptz not null default now()
);
create unique index if not exists area_rates_store_area_unique on public.area_rates (coalesce(store_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(area));

create table if not exists public.warehouse_counts (
  id uuid primary key default gen_random_uuid(),
  counted_at timestamptz not null default now(),
  expected_count integer not null check (expected_count >= 0),
  actual_count integer not null check (actual_count >= 0),
  note text,
  created_by uuid not null references public.profiles(id)
);

create table if not exists public.order_exceptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  reason text not null,
  next_action text,
  owner_id uuid references public.profiles(id),
  resolved_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists order_exceptions_open_idx on public.order_exceptions(resolved_at,created_at);

alter table public.area_rates enable row level security;
alter table public.warehouse_counts enable row level security;
alter table public.order_exceptions enable row level security;
revoke all on public.area_rates,public.warehouse_counts,public.order_exceptions from anon;
grant select,insert,update,delete on public.area_rates,public.warehouse_counts,public.order_exceptions to authenticated;

create policy area_rates_read on public.area_rates for select to authenticated using (public.is_staff() or (store_id is not null and public.is_store_member(store_id)));
create policy area_rates_insert on public.area_rates for insert to authenticated with check (public.is_admin());
create policy area_rates_update on public.area_rates for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy area_rates_delete on public.area_rates for delete to authenticated using (public.is_admin());
create policy warehouse_counts_read on public.warehouse_counts for select to authenticated using (public.is_staff());
create policy warehouse_counts_insert on public.warehouse_counts for insert to authenticated with check (public.is_staff() and created_by=(select auth.uid()));
create policy exceptions_read on public.order_exceptions for select to authenticated using (public.is_staff() or public.is_assigned_captain(order_id));
create policy exceptions_insert on public.order_exceptions for insert to authenticated with check (public.is_staff() and created_by=(select auth.uid()));
create policy exceptions_update on public.order_exceptions for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- Audit changes made by staff as well as existing RPCs. Excludes read-only operations.
create or replace function public.log_order_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if row(old.status,old.amount_to_collect,old.delivery_fee,old.customer_phone,old.address,old.delivery_captain_id,old.pickup_captain_id,old.payment_type,old.parcel_count,old.shelf_location,old.exception_reason)
    is distinct from
    row(new.status,new.amount_to_collect,new.delivery_fee,new.customer_phone,new.address,new.delivery_captain_id,new.pickup_captain_id,new.payment_type,new.parcel_count,new.shelf_location,new.exception_reason) then
    insert into public.order_events(order_id,event_type,old_status,new_status,actor_id,meta)
    values(new.id,'order_updated',old.status,new.status,auth.uid(),jsonb_build_object(
      'old_amount',old.amount_to_collect,'new_amount',new.amount_to_collect,
      'old_captain',old.delivery_captain_id,'new_captain',new.delivery_captain_id,
      'old_payment',old.payment_type,'new_payment',new.payment_type));
  end if;
  return new;
end $$;
revoke all on function public.log_order_change() from public,anon,authenticated;
drop trigger if exists log_order_change on public.orders;
create trigger log_order_change after update on public.orders for each row execute function public.log_order_change();

create or replace function public.store_set_order_options(p_order_id uuid,p_payment_type text,p_parcel_count integer,p_priority text)
returns public.orders language plpgsql security definer set search_path=public as $$
declare result public.orders;
begin
  if p_payment_type not in ('cod','prepaid') or p_parcel_count not between 1 and 100 or p_priority not in ('normal','urgent') then
    raise exception 'INVALID_OPTIONS';
  end if;
  update public.orders set payment_type=p_payment_type,parcel_count=p_parcel_count,priority=p_priority
  where id=p_order_id and created_by=auth.uid() and status='new' and public.is_store_member(store_id)
  returning * into result;
  if not found then raise exception 'ORDER_NOT_AVAILABLE'; end if;
  return result;
end $$;
revoke all on function public.store_set_order_options(uuid,text,integer,text) from public,anon;
grant execute on function public.store_set_order_options(uuid,text,integer,text) to authenticated;

create or replace function public.set_area_rate() returns trigger language plpgsql set search_path=public as $$
declare fee numeric;
begin
  select delivery_fee into fee from public.area_rates where lower(area)=lower(new.area)
    and (store_id=new.store_id or store_id is null)
    order by (store_id is not null) desc limit 1;
  if found then new.delivery_fee=fee; end if;
  return new;
end $$;
drop trigger if exists zzz_set_area_rate on public.orders;
create trigger zzz_set_area_rate before insert on public.orders for each row execute function public.set_area_rate();

-- Prepaid orders do not put cash in a captain's hand or in the store remittance.
create or replace view public.captain_cash_summary with (security_invoker=true) as
select c.id captain_id,p.full_name,count(o.id) filter(where o.status='delivered') delivered_orders,
  coalesce(sum(o.amount_to_collect) filter(where o.status='delivered' and o.payment_type='cod'),0)::numeric(12,2) cash_collected,
  coalesce((select sum(ch.amount) from public.captain_handovers ch where ch.captain_id=c.id),0)::numeric(12,2) cash_handed_over,
  (coalesce(sum(o.amount_to_collect) filter(where o.status='delivered' and o.payment_type='cod'),0)-coalesce((select sum(ch.amount) from public.captain_handovers ch where ch.captain_id=c.id),0))::numeric(12,2) cash_due
from public.captains c join public.profiles p on p.id=c.id left join public.orders o on o.delivery_captain_id=c.id group by c.id,p.full_name;
create or replace view public.store_balance_summary with (security_invoker=true) as
select s.id store_id,s.name store_name,count(o.id) total_orders,
  count(o.id) filter(where o.status='delivered') delivered_orders,
  count(o.id) filter(where o.status='returned_store') returned_orders,
  coalesce(sum(o.amount_to_collect) filter(where o.status='delivered' and o.payment_type='cod'),0)::numeric(12,2) collections,
  coalesce(sum(o.delivery_fee) filter(where o.status='delivered'),0)::numeric(12,2) delivery_fees,
  coalesce(sum(o.return_fee) filter(where o.status='returned_store'),0)::numeric(12,2) return_fees,
  coalesce((select sum(ss.amount) from public.store_settlements ss where ss.store_id=s.id),0)::numeric(12,2) paid_out,
  (coalesce(sum(o.amount_to_collect) filter(where o.status='delivered' and o.payment_type='cod'),0)
   -coalesce(sum(o.delivery_fee) filter(where o.status='delivered'),0)
   -coalesce(sum(o.return_fee) filter(where o.status='returned_store'),0)
   -coalesce((select sum(ss.amount) from public.store_settlements ss where ss.store_id=s.id),0))::numeric(12,2) balance_due
from public.stores s left join public.orders o on o.store_id=s.id group by s.id,s.name;
