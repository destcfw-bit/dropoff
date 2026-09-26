-- Complete captain workforce suite: geofenced attendance, leave, overtime approval,
-- payroll adjustments/locking/receipt, performance incentives and protected audit history.

alter table public.captain_shifts
  add column check_in_latitude double precision check(check_in_latitude between -90 and 90),
  add column check_in_longitude double precision check(check_in_longitude between -180 and 180),
  add column check_in_accuracy_m double precision check(check_in_accuracy_m between 0 and 100000);

grant insert(captain_id,check_in_latitude,check_in_longitude,check_in_accuracy_m) on public.captain_shifts to authenticated;

create table public.captain_workforce_settings (
  id boolean primary key default true check(id),
  company_latitude double precision check(company_latitude between -90 and 90),
  company_longitude double precision check(company_longitude between -180 and 180),
  geofence_radius_m integer not null default 250 check(geofence_radius_m between 30 and 5000),
  forgotten_checkout_hours numeric(5,2) not null default 12 check(forgotten_checkout_hours between 1 and 48),
  location_stale_minutes integer not null default 3 check(location_stale_minutes between 1 and 60),
  performance_order_target integer not null default 300 check(performance_order_target between 1 and 100000),
  performance_bonus numeric(12,2) not null default 0 check(performance_bonus between 0 and 10000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
insert into public.captain_workforce_settings(id) values(true);
alter table public.captain_workforce_settings enable row level security;
create policy workforce_settings_read on public.captain_workforce_settings for select to authenticated using (public.current_user_role() in ('admin','accountant','pickup_captain','delivery_captain'));
create policy workforce_settings_update on public.captain_workforce_settings for update to authenticated using (public.finance_access()) with check (public.finance_access());
revoke all on public.captain_workforce_settings from anon,authenticated;
grant select on public.captain_workforce_settings to authenticated;
grant update(company_latitude,company_longitude,geofence_radius_m,forgotten_checkout_hours,location_stale_minutes,performance_order_target,performance_bonus) on public.captain_workforce_settings to authenticated;

create function public.guard_workforce_settings() returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if not public.finance_access() then raise exception 'غير مخوّل'; end if;
  new.id:=true;new.updated_at:=now();new.updated_by:=auth.uid();
  return new;
end $$;
create trigger workforce_settings_guard before update on public.captain_workforce_settings for each row execute function public.guard_workforce_settings();
revoke all on function public.guard_workforce_settings() from public,anon,authenticated;

-- Replace the attendance guard so database time, the company geofence and cash clearance
-- remain enforceable even if a client bypasses the visible buttons.
create or replace function public.guard_captain_shift() returns trigger language plpgsql security invoker set search_path=public as $$
declare
  v_due numeric;v_lat double precision;v_lon double precision;v_radius integer;v_a double precision;v_distance double precision;
begin
  if tg_op='INSERT' then
    if new.captain_id <> auth.uid() or not exists (
      select 1 from public.captains c join public.profiles p on p.id=c.id
      where c.id=new.captain_id and c.active and p.active and p.role in ('pickup_captain','delivery_captain')
    ) then raise exception 'حساب الكابتن غير نشط'; end if;
    select company_latitude,company_longitude,geofence_radius_m into v_lat,v_lon,v_radius
      from public.captain_workforce_settings where id=true;
    if v_lat is not null and v_lon is not null then
      if new.check_in_latitude is null or new.check_in_longitude is null then
        raise exception 'فعّل الموقع لتسجيل الحضور من مقر الشركة';
      end if;
      v_a:=power(sin(radians(new.check_in_latitude-v_lat)/2),2)
        +cos(radians(v_lat))*cos(radians(new.check_in_latitude))*power(sin(radians(new.check_in_longitude-v_lon)/2),2);
      v_distance:=6371000*2*asin(sqrt(least(1,greatest(0,v_a))));
      if v_distance>v_radius then raise exception 'أنت خارج نطاق مقر الشركة (% متر)',round(v_distance); end if;
    end if;
    new.checked_in_at:=now();new.checked_out_at:=null;
  else
    if old.captain_id <> auth.uid() or old.checked_out_at is not null or
       new.id is distinct from old.id or new.captain_id is distinct from old.captain_id or
       new.checked_in_at is distinct from old.checked_in_at or
       new.check_in_latitude is distinct from old.check_in_latitude or
       new.check_in_longitude is distinct from old.check_in_longitude or
       new.check_in_accuracy_m is distinct from old.check_in_accuracy_m then
      raise exception 'تعديل الدوام غير مسموح';
    end if;
    if public.current_user_role()='delivery_captain' then
      select coalesce(cash_due,0) into v_due from public.captain_cash_summary where captain_id=old.captain_id;
      if coalesce(v_due,0)>0 then raise exception 'سلّم الكاش للمحاسب قبل إنهاء الدوام'; end if;
    end if;
    new.checked_out_at:=now();
  end if;
  return new;
end $$;

create table public.captain_overtime_reviews (
  shift_id uuid primary key references public.captain_shifts(id) on delete cascade,
  status text not null check(status in ('approved','rejected')),
  note text check(char_length(note)<=500),
  reviewed_at timestamptz not null default now(),
  reviewed_by uuid not null references public.profiles(id)
);
create index captain_overtime_status on public.captain_overtime_reviews(status,reviewed_at desc);
alter table public.captain_overtime_reviews enable row level security;
create policy overtime_read on public.captain_overtime_reviews for select to authenticated using (
  public.finance_access() or exists(select 1 from public.captain_shifts s where s.id=shift_id and s.captain_id=auth.uid())
);
create policy overtime_add on public.captain_overtime_reviews for insert to authenticated with check (public.finance_access() and reviewed_by=auth.uid());
create policy overtime_update on public.captain_overtime_reviews for update to authenticated using (public.finance_access()) with check (public.finance_access() and reviewed_by=auth.uid());
create policy overtime_admin_delete on public.captain_overtime_reviews for delete to authenticated using (public.current_user_role()='admin');
revoke all on public.captain_overtime_reviews from anon,authenticated;
grant select,insert,delete on public.captain_overtime_reviews to authenticated;
grant update(status,note) on public.captain_overtime_reviews to authenticated;

create function public.guard_overtime_review() returns trigger language plpgsql security invoker set search_path=public as $$
declare v_checkout timestamptz;v_cutoff timestamptz;v_captain uuid;v_month date;v_shift uuid;
begin
  if not public.finance_access() then raise exception 'غير مخوّل'; end if;
  v_shift:=case when tg_op='DELETE' then old.shift_id else new.shift_id end;
  select s.checked_out_at,(((s.checked_in_at at time zone 'Asia/Amman')::date+coalesce(r.workday_end,'17:00'::time)) at time zone 'Asia/Amman')
    ,s.captain_id,date_trunc('month',s.checked_in_at at time zone 'Asia/Amman')::date
    into v_checkout,v_cutoff,v_captain,v_month from public.captain_shifts s left join public.captain_pay_rates r on r.captain_id=s.captain_id where s.id=v_shift;
  if exists(select 1 from public.captain_payroll_closures c where c.captain_id=v_captain and c.payroll_month=v_month) then raise exception 'الراتب مسكّر؛ ألغِ التسكير أولاً'; end if;
  if tg_op='DELETE' then return old; end if;
  if v_checkout is null or v_checkout<=v_cutoff then raise exception 'لا توجد ساعات إضافية مكتملة لهذه الوردية'; end if;
  new.reviewed_at:=now();new.reviewed_by:=auth.uid();
  return new;
end $$;
create trigger overtime_review_guard before insert or update or delete on public.captain_overtime_reviews for each row execute function public.guard_overtime_review();
revoke all on function public.guard_overtime_review() from public,anon,authenticated;

create table public.captain_leave_requests (
  id uuid primary key default gen_random_uuid(),
  captain_id uuid not null references public.captains(id),
  date_from date not null,
  date_to date not null,
  reason text not null check(char_length(trim(reason)) between 3 and 500),
  status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
  review_note text check(char_length(review_note)<=500),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check(date_to>=date_from),
  check(date_to-date_from<=60)
);
create index captain_leave_captain_dates on public.captain_leave_requests(captain_id,date_from,date_to);
create index captain_leave_status on public.captain_leave_requests(status,created_at desc);
alter table public.captain_leave_requests enable row level security;
create policy leaves_read on public.captain_leave_requests for select to authenticated using (captain_id=auth.uid() or public.finance_access());
create policy leaves_add on public.captain_leave_requests for insert to authenticated with check (captain_id=auth.uid() and status='pending');
create policy leaves_captain_cancel on public.captain_leave_requests for update to authenticated using (captain_id=auth.uid() and status='pending') with check (captain_id=auth.uid());
create policy leaves_finance_review on public.captain_leave_requests for update to authenticated using (public.finance_access()) with check (public.finance_access());
revoke all on public.captain_leave_requests from anon,authenticated;
grant select,insert on public.captain_leave_requests to authenticated;
grant update(status,review_note,reviewed_at,reviewed_by) on public.captain_leave_requests to authenticated;

create function public.guard_leave_request() returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='INSERT' then
    if public.current_user_role() not in ('pickup_captain','delivery_captain') then raise exception 'هذا الطلب للكباتن فقط'; end if;
    new.captain_id:=auth.uid();new.status:='pending';new.reviewed_at:=null;new.reviewed_by:=null;new.review_note:=null;
  elsif public.finance_access() then
    if new.captain_id is distinct from old.captain_id or new.date_from is distinct from old.date_from or new.date_to is distinct from old.date_to or new.reason is distinct from old.reason then raise exception 'يمكن مراجعة حالة الطلب فقط'; end if;
    if new.status not in ('approved','rejected') then raise exception 'اختر قبول أو رفض'; end if;
    new.reviewed_at:=now();new.reviewed_by:=auth.uid();
  else
    if old.captain_id<>auth.uid() or old.status<>'pending' or new.status<>'cancelled' or
       new.captain_id is distinct from old.captain_id or new.date_from is distinct from old.date_from or new.date_to is distinct from old.date_to or new.reason is distinct from old.reason then
      raise exception 'يمكنك إلغاء الطلب المعلّق فقط';
    end if;
    new.reviewed_at:=now();new.reviewed_by:=auth.uid();new.review_note:='ألغاه الكابتن';
  end if;
  return new;
end $$;
create trigger leave_request_guard before insert or update on public.captain_leave_requests for each row execute function public.guard_leave_request();
revoke all on function public.guard_leave_request() from public,anon,authenticated;

create table public.captain_payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  captain_id uuid not null references public.captains(id),
  payroll_month date not null check(payroll_month=date_trunc('month',payroll_month)::date),
  kind text not null check(kind in ('bonus','advance','deduction','damage','fine','other_addition','other_deduction')),
  amount numeric(12,2) not null check(amount>0 and amount<=100000),
  note text not null check(char_length(trim(note)) between 2 and 500),
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id)
);
create index payroll_adjustments_captain_month on public.captain_payroll_adjustments(captain_id,payroll_month);
alter table public.captain_payroll_adjustments enable row level security;
create policy adjustments_read on public.captain_payroll_adjustments for select to authenticated using (captain_id=auth.uid() or public.finance_access());
create policy adjustments_add on public.captain_payroll_adjustments for insert to authenticated with check (public.finance_access() and created_by=auth.uid());
create policy adjustments_admin_delete on public.captain_payroll_adjustments for delete to authenticated using (public.current_user_role()='admin');
revoke all on public.captain_payroll_adjustments from anon,authenticated;
grant select,insert,delete on public.captain_payroll_adjustments to authenticated;

create function public.guard_payroll_adjustment() returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='DELETE' then
    if public.current_user_role()<>'admin' then raise exception 'الحذف للإدارة فقط'; end if;
    if exists(select 1 from public.captain_payroll_closures c where c.captain_id=old.captain_id and c.payroll_month=old.payroll_month) then raise exception 'الراتب مسكّر؛ ألغِ التسكير أولاً'; end if;
    return old;
  end if;
  if not public.finance_access() then raise exception 'غير مخوّل'; end if;
  if exists(select 1 from public.captain_payroll_closures c where c.captain_id=new.captain_id and c.payroll_month=new.payroll_month) then raise exception 'الراتب مسكّر؛ ألغِ التسكير أولاً'; end if;
  new.created_at:=now();new.created_by:=auth.uid();
  return new;
end $$;
create trigger payroll_adjustment_guard before insert or delete on public.captain_payroll_adjustments for each row execute function public.guard_payroll_adjustment();
revoke all on function public.guard_payroll_adjustment() from public,anon,authenticated;

create table public.captain_payroll_closures (
  id uuid primary key default gen_random_uuid(),
  captain_id uuid not null references public.captains(id),
  payroll_month date not null check(payroll_month=date_trunc('month',payroll_month)::date),
  snapshot jsonb not null,
  gross_amount numeric(12,2) not null check(gross_amount>=0),
  adjustments_total numeric(12,2) not null default 0,
  net_amount numeric(12,2) not null check(net_amount>=0),
  locked_at timestamptz not null default now(),
  locked_by uuid not null references public.profiles(id),
  paid_at timestamptz,
  paid_by uuid references public.profiles(id),
  payment_method text check(payment_method in ('cash','bank')),
  payment_reference text check(char_length(payment_reference)<=200),
  acknowledged_at timestamptz,
  unique(captain_id,payroll_month)
);
create index payroll_closures_month on public.captain_payroll_closures(payroll_month,locked_at desc);
alter table public.captain_payroll_closures enable row level security;
create policy closures_read on public.captain_payroll_closures for select to authenticated using (captain_id=auth.uid() or public.finance_access());
create policy closures_add on public.captain_payroll_closures for insert to authenticated with check (public.finance_access() and locked_by=auth.uid());
create policy closures_finance_update on public.captain_payroll_closures for update to authenticated using (public.finance_access()) with check (public.finance_access());
create policy closures_captain_ack on public.captain_payroll_closures for update to authenticated using (captain_id=auth.uid() and paid_at is not null) with check (captain_id=auth.uid());
create policy closures_admin_delete on public.captain_payroll_closures for delete to authenticated using (public.current_user_role()='admin' and paid_at is null);
revoke all on public.captain_payroll_closures from anon,authenticated;
grant select,insert,delete on public.captain_payroll_closures to authenticated;
grant update(paid_at,paid_by,payment_method,payment_reference,acknowledged_at) on public.captain_payroll_closures to authenticated;

create function public.guard_payroll_closure() returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='INSERT' then
    if not public.finance_access() then raise exception 'غير مخوّل'; end if;
    new.locked_at:=now();new.locked_by:=auth.uid();new.paid_at:=null;new.paid_by:=null;new.payment_method:=null;new.payment_reference:=null;new.acknowledged_at:=null;
  elsif tg_op='UPDATE' then
    if new.id is distinct from old.id or new.captain_id is distinct from old.captain_id or new.payroll_month is distinct from old.payroll_month or
       new.snapshot is distinct from old.snapshot or new.gross_amount is distinct from old.gross_amount or new.adjustments_total is distinct from old.adjustments_total or
       new.net_amount is distinct from old.net_amount or new.locked_at is distinct from old.locked_at or new.locked_by is distinct from old.locked_by then
      raise exception 'الراتب المسكّر لا يمكن تعديله';
    end if;
    if public.finance_access() then
      if old.paid_at is not null and (new.paid_at is distinct from old.paid_at or new.paid_by is distinct from old.paid_by or new.payment_method is distinct from old.payment_method or new.payment_reference is distinct from old.payment_reference) then
        raise exception 'تم دفع هذا الراتب مسبقاً';
      end if;
      if new.paid_at is not null and old.paid_at is null then new.paid_at:=now();new.paid_by:=auth.uid(); end if;
    else
      if old.captain_id<>auth.uid() or old.paid_at is null or new.paid_at is distinct from old.paid_at or new.paid_by is distinct from old.paid_by or
         new.payment_method is distinct from old.payment_method or new.payment_reference is distinct from old.payment_reference then
        raise exception 'يمكن تأكيد استلام الراتب المدفوع فقط';
      end if;
      new.acknowledged_at:=now();
    end if;
  elsif tg_op='DELETE' then
    if public.current_user_role()<>'admin' or old.paid_at is not null then raise exception 'لا يمكن إلغاء هذا التسكير'; end if;
    return old;
  end if;
  return new;
end $$;
create trigger payroll_closure_guard before insert or update or delete on public.captain_payroll_closures for each row execute function public.guard_payroll_closure();
revoke all on function public.guard_payroll_closure() from public,anon,authenticated;

create or replace function public.pay_captain_salary(p_closure_id uuid,p_method text default 'cash',p_reference text default null)
returns public.captain_payroll_closures language plpgsql security invoker set search_path=public as $$
declare v_row public.captain_payroll_closures;v_name text;
begin
  if not public.finance_access() then raise exception 'غير مخوّل'; end if;
  if p_method not in ('cash','bank') then raise exception 'طريقة الدفع غير صحيحة'; end if;
  update public.captain_payroll_closures set paid_at=now(),payment_method=p_method,payment_reference=nullif(trim(p_reference),'')
    where id=p_closure_id and paid_at is null returning * into v_row;
  if v_row.id is null then raise exception 'الراتب غير موجود أو مدفوع مسبقاً'; end if;
  select full_name into v_name from public.profiles where id=v_row.captain_id;
  insert into public.accounting_expenses(amount,method,category,note,spent_at,created_by)
    values(v_row.net_amount,p_method,'salary','راتب '||coalesce(v_name,'كابتن')||' - '||to_char(v_row.payroll_month,'YYYY-MM'),now(),auth.uid());
  return v_row;
end $$;
revoke all on function public.pay_captain_salary(uuid,text,text) from public,anon;
grant execute on function public.pay_captain_salary(uuid,text,text) to authenticated;

create table public.captain_payroll_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  table_name text not null,
  action text not null check(action in ('INSERT','UPDATE','DELETE')),
  record_key text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index payroll_audit_created on public.captain_payroll_audit_logs(created_at desc);
create index payroll_audit_actor on public.captain_payroll_audit_logs(actor_id,created_at desc);
alter table public.captain_payroll_audit_logs enable row level security;
create policy payroll_audit_read on public.captain_payroll_audit_logs for select to authenticated using (public.finance_access());
revoke all on public.captain_payroll_audit_logs from anon,authenticated;
grant select on public.captain_payroll_audit_logs to authenticated;

create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create or replace function private.log_captain_workforce_change() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_old jsonb;v_new jsonb;v_key text;
begin
  if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then v_new:=to_jsonb(new); end if;
  v_key:=coalesce(v_new->>'id',v_old->>'id',v_new->>'captain_id',v_old->>'captain_id',v_new->>'shift_id',v_old->>'shift_id','settings');
  insert into public.captain_payroll_audit_logs(actor_id,table_name,action,record_key,old_data,new_data)
    values(auth.uid(),tg_table_name,tg_op,v_key,v_old,v_new);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.log_captain_workforce_change() from public,anon,authenticated;

do $$
declare t text;
begin
  foreach t in array array['captain_shifts','captain_pay_rates','captain_workforce_settings','captain_overtime_reviews','captain_leave_requests','captain_payroll_adjustments','captain_payroll_closures'] loop
    execute format('drop trigger if exists workforce_audit on public.%I',t);
    execute format('create trigger workforce_audit after insert or update or delete on public.%I for each row execute function private.log_captain_workforce_change()',t);
  end loop;
end $$;
