-- Captain attendance uses database time. Location is a single current fix, never a route history.
create table public.captain_shifts (
  id uuid primary key default gen_random_uuid(),
  captain_id uuid not null references public.captains(id),
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz,
  check (checked_out_at is null or checked_out_at >= checked_in_at)
);
create unique index captain_one_open_shift on public.captain_shifts(captain_id) where checked_out_at is null;
create index captain_shifts_period on public.captain_shifts(checked_in_at,checked_out_at);

create table public.captain_live_locations (
  captain_id uuid primary key references public.captains(id),
  shift_id uuid not null references public.captain_shifts(id),
  latitude double precision not null check(latitude between -90 and 90),
  longitude double precision not null check(longitude between -180 and 180),
  accuracy_m double precision check(accuracy_m between 0 and 100000),
  updated_at timestamptz not null default now()
);

create table public.captain_pay_rates (
  captain_id uuid primary key references public.captains(id),
  hourly_rate numeric(12,2) not null check(hourly_rate >= 0 and hourly_rate <= 1000),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id)
);

-- Trigger enforces server time and cash clearance even when the client skips the UI.
create function public.guard_captain_shift() returns trigger language plpgsql security invoker set search_path=public as $$
declare v_due numeric;
begin
  if tg_op='INSERT' then
    if new.captain_id <> auth.uid() or not exists (
      select 1 from public.captains c join public.profiles p on p.id=c.id
      where c.id=new.captain_id and c.active and p.active and p.role in ('pickup_captain','delivery_captain')
    ) then raise exception 'حساب الكابتن غير نشط'; end if;
    new.checked_in_at:=now(); new.checked_out_at:=null;
  else
    if old.captain_id <> auth.uid() or old.checked_out_at is not null or
       new.id is distinct from old.id or new.captain_id is distinct from old.captain_id or
       new.checked_in_at is distinct from old.checked_in_at then
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
create trigger captain_shift_guard before insert or update on public.captain_shifts for each row execute function public.guard_captain_shift();

create function public.guard_captain_location() returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.captain_id <> auth.uid() or (tg_op='UPDATE' and new.captain_id is distinct from old.captain_id) or
     not exists (select 1 from public.captain_shifts s where s.id=new.shift_id and s.captain_id=new.captain_id and s.checked_out_at is null) then
    raise exception 'تحديث الموقع متاح أثناء دوامك فقط';
  end if;
  new.updated_at:=now();
  return new;
end $$;
create trigger captain_location_guard before insert or update on public.captain_live_locations for each row execute function public.guard_captain_location();
create function public.guard_captain_pay_rate() returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if not public.finance_access() then raise exception 'غير مخوّل'; end if;
  new.updated_by:=auth.uid();new.updated_at:=now();
  return new;
end $$;
create trigger captain_rate_guard before insert or update on public.captain_pay_rates for each row execute function public.guard_captain_pay_rate();

alter table public.captain_shifts enable row level security;
alter table public.captain_live_locations enable row level security;
alter table public.captain_pay_rates enable row level security;
create policy shifts_read on public.captain_shifts for select to authenticated using (captain_id=(select auth.uid()) or public.finance_access());
create policy shifts_start on public.captain_shifts for insert to authenticated with check (captain_id=(select auth.uid()) and checked_out_at is null and public.current_user_role() in ('pickup_captain','delivery_captain'));
create policy shifts_end on public.captain_shifts for update to authenticated using (captain_id=(select auth.uid()) and checked_out_at is null) with check (captain_id=(select auth.uid()));
create policy locations_read on public.captain_live_locations for select to authenticated using (captain_id=(select auth.uid()) or (public.finance_access() and exists(select 1 from public.captain_shifts s where s.id=shift_id and s.checked_out_at is null)));
create policy locations_add on public.captain_live_locations for insert to authenticated with check (captain_id=(select auth.uid()) and public.current_user_role() in ('pickup_captain','delivery_captain') and exists(select 1 from public.captain_shifts s where s.id=shift_id and s.captain_id=(select auth.uid()) and s.checked_out_at is null));
create policy locations_update on public.captain_live_locations for update to authenticated using (captain_id=(select auth.uid())) with check (captain_id=(select auth.uid()) and exists(select 1 from public.captain_shifts s where s.id=shift_id and s.captain_id=(select auth.uid()) and s.checked_out_at is null));
create policy rates_read on public.captain_pay_rates for select to authenticated using (public.finance_access() or captain_id=(select auth.uid()));
create policy rates_add on public.captain_pay_rates for insert to authenticated with check (public.finance_access() and updated_by=(select auth.uid()));
create policy rates_update on public.captain_pay_rates for update to authenticated using (public.finance_access()) with check (public.finance_access() and updated_by=(select auth.uid()));

revoke all on public.captain_shifts,public.captain_live_locations,public.captain_pay_rates from anon,authenticated;
grant select,insert on public.captain_shifts to authenticated;
grant update(checked_out_at) on public.captain_shifts to authenticated;
grant select,insert on public.captain_live_locations to authenticated;
grant update(shift_id,latitude,longitude,accuracy_m) on public.captain_live_locations to authenticated;
grant select,insert on public.captain_pay_rates to authenticated;
grant update(hourly_rate) on public.captain_pay_rates to authenticated;
revoke all on function public.guard_captain_shift(),public.guard_captain_location(),public.guard_captain_pay_rate() from public,anon,authenticated;
