
-- Finish owner/manager operational permissions for OS V2.

drop policy if exists shelves_staff_read on public.warehouse_shelves;
create policy shelves_staff_read on public.warehouse_shelves for select to authenticated
using(public.current_user_role() in ('owner','admin','manager','warehouse','dispatcher','accountant'));

drop policy if exists shelves_staff_insert on public.warehouse_shelves;
create policy shelves_staff_insert on public.warehouse_shelves for insert to authenticated
with check(public.current_user_role() in ('owner','admin','manager','warehouse'));

drop policy if exists shelves_staff_update on public.warehouse_shelves;
create policy shelves_staff_update on public.warehouse_shelves for update to authenticated
using(public.current_user_role() in ('owner','admin','manager','warehouse'))
with check(public.current_user_role() in ('owner','admin','manager','warehouse'));

drop policy if exists shelves_staff_delete on public.warehouse_shelves;
create policy shelves_staff_delete on public.warehouse_shelves for delete to authenticated
using(public.current_user_role() in ('owner','admin','manager','warehouse'));

drop policy if exists stores_manager_insert on public.stores;
create policy stores_manager_insert on public.stores for insert to authenticated
with check(public.current_user_role()='manager');

drop policy if exists pricing_read on public.pricing_rules;
create policy pricing_read on public.pricing_rules for select to authenticated
using(
  public.current_user_role() in ('owner','admin','manager','accountant','warehouse')
  or (store_id is not null and public.is_store_member(store_id))
);

drop policy if exists attachments_delete on public.order_attachments;
create policy attachments_delete on public.order_attachments for delete to authenticated
using(
  public.current_user_role() in ('owner','admin','manager','warehouse')
  or uploaded_by=(select auth.uid())
);

drop policy if exists audit_read on public.audit_logs;
create policy audit_read on public.audit_logs for select to authenticated
using(public.current_user_role() in ('owner','admin','accountant'));

create or replace function public.refresh_order_exceptions()
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0;
begin
  if public.current_user_role() not in ('owner','admin','manager','warehouse') then raise exception 'NOT_ALLOWED'; end if;

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

  if v_role not in ('owner','admin','manager','warehouse','dispatcher') and not (
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
