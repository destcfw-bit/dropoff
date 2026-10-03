
-- Security/performance hardening for Operating System V2.

-- Explicitly deny client access to raw login attempt hashes while keeping service-role logging.
revoke all on public.login_attempts from anon,authenticated;
drop policy if exists login_attempts_explicit_deny on public.login_attempts;
create policy login_attempts_explicit_deny on public.login_attempts
for select to authenticated using (false);

-- Avoid overlapping SELECT policies on new tables.
drop policy if exists branches_admin on public.branches;
drop policy if exists branches_admin_insert on public.branches;
drop policy if exists branches_admin_update on public.branches;
drop policy if exists branches_admin_delete on public.branches;
create policy branches_admin_insert on public.branches for insert to authenticated with check(public.is_admin());
create policy branches_admin_update on public.branches for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy branches_admin_delete on public.branches for delete to authenticated using(public.is_admin());

drop policy if exists permissions_admin on public.profile_permissions;
drop policy if exists permissions_admin_insert on public.profile_permissions;
drop policy if exists permissions_admin_update on public.profile_permissions;
drop policy if exists permissions_admin_delete on public.profile_permissions;
create policy permissions_admin_insert on public.profile_permissions for insert to authenticated with check(public.is_admin());
create policy permissions_admin_update on public.profile_permissions for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy permissions_admin_delete on public.profile_permissions for delete to authenticated using(public.is_admin());

drop policy if exists pricing_admin on public.pricing_rules;
drop policy if exists pricing_admin_insert on public.pricing_rules;
drop policy if exists pricing_admin_update on public.pricing_rules;
drop policy if exists pricing_admin_delete on public.pricing_rules;
create policy pricing_admin_insert on public.pricing_rules for insert to authenticated with check(public.is_admin());
create policy pricing_admin_update on public.pricing_rules for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy pricing_admin_delete on public.pricing_rules for delete to authenticated using(public.is_admin());

drop policy if exists shelves_admin_write on public.warehouse_shelves;
drop policy if exists shelves_staff_insert on public.warehouse_shelves;
drop policy if exists shelves_staff_update on public.warehouse_shelves;
drop policy if exists shelves_staff_delete on public.warehouse_shelves;
create policy shelves_staff_insert on public.warehouse_shelves for insert to authenticated
  with check(public.current_user_role() in ('admin','warehouse'));
create policy shelves_staff_update on public.warehouse_shelves for update to authenticated
  using(public.current_user_role() in ('admin','warehouse')) with check(public.current_user_role() in ('admin','warehouse'));
create policy shelves_staff_delete on public.warehouse_shelves for delete to authenticated
  using(public.current_user_role() in ('admin','warehouse'));

drop policy if exists flags_admin on public.feature_flags;
drop policy if exists flags_admin_insert on public.feature_flags;
drop policy if exists flags_admin_update on public.feature_flags;
drop policy if exists flags_admin_delete on public.feature_flags;
create policy flags_admin_insert on public.feature_flags for insert to authenticated with check(public.is_admin());
create policy flags_admin_update on public.feature_flags for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy flags_admin_delete on public.feature_flags for delete to authenticated using(public.is_admin());

drop policy if exists ai_daily_admin_write on public.ai_daily_summaries;
drop policy if exists ai_daily_admin_insert on public.ai_daily_summaries;
drop policy if exists ai_daily_admin_update on public.ai_daily_summaries;
drop policy if exists ai_daily_admin_delete on public.ai_daily_summaries;
create policy ai_daily_admin_insert on public.ai_daily_summaries for insert to authenticated with check(public.is_admin());
create policy ai_daily_admin_update on public.ai_daily_summaries for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy ai_daily_admin_delete on public.ai_daily_summaries for delete to authenticated using(public.is_admin());

-- New FK indexes.
create index if not exists stores_branch_id_idx on public.stores(branch_id);
create index if not exists captains_branch_id_idx on public.captains(branch_id);
create index if not exists orders_branch_id_idx on public.orders(branch_id);
create index if not exists orders_pricing_rule_id_idx on public.orders(pricing_rule_id);
create index if not exists sticker_rolls_branch_id_idx on public.sticker_rolls(branch_id);
create index if not exists warehouse_counts_branch_id_idx on public.warehouse_counts(branch_id);
create index if not exists profile_permissions_granted_by_idx on public.profile_permissions(granted_by);
create index if not exists pricing_rules_store_id_idx on public.pricing_rules(store_id);
create index if not exists pricing_rules_branch_id_idx on public.pricing_rules(branch_id);
create index if not exists pricing_rules_created_by_idx on public.pricing_rules(created_by);
create index if not exists warehouse_shelves_branch_id_idx on public.warehouse_shelves(branch_id);
create index if not exists order_scans_shelf_id_idx on public.order_scans(shelf_id);
create index if not exists order_scans_actor_id_idx on public.order_scans(actor_id);
create index if not exists order_scans_captain_id_idx on public.order_scans(captain_id);
create index if not exists order_attachments_uploaded_by_idx on public.order_attachments(uploaded_by);
create index if not exists feature_flags_store_id_idx on public.feature_flags(store_id);
create index if not exists feature_flags_updated_by_idx on public.feature_flags(updated_by);
create index if not exists store_api_keys_created_by_idx on public.store_api_keys(created_by);
create index if not exists security_settings_updated_by_idx on public.security_settings(updated_by);

-- Smart dispatcher is staff/finance only.
create or replace function public.suggest_captains_for_order(p_order_id uuid)
returns table(
  captain_id uuid,full_name text,active_orders bigint,daily_capacity integer,
  area_affinity bigint,recommendation_score numeric
)
language plpgsql stable security definer set search_path=public as $$
begin
  if public.current_user_role() not in ('admin','warehouse','accountant') then
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

-- Validation can be used only by staff or a member of the selected store.
create or replace function public.validate_order_candidate(
  p_store_id uuid,p_customer_name text,p_customer_phone text,p_area text,p_address text,
  p_amount numeric,p_payment_type text,p_parcel_count integer
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare warnings jsonb:='[]'::jsonb; duplicates integer:=0;
begin
  if public.current_user_role() not in ('admin','warehouse','accountant','store_owner')
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
