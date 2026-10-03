
-- Drop Off Operating System v2: security, logical backups, daily AI summaries and health.

create table if not exists public.security_settings (
  id boolean primary key default true check(id),
  max_failed_attempts integer not null default 5 check(max_failed_attempts between 2 and 20),
  window_minutes integer not null default 15 check(window_minutes between 1 and 120),
  lock_minutes integer not null default 15 check(lock_minutes between 1 and 1440),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
insert into public.security_settings(id) values(true) on conflict(id) do nothing;

create table if not exists public.login_attempts (
  id bigint generated always as identity primary key,
  identifier_hash text not null,
  ip_hash text,
  successful boolean not null default false,
  reason text,
  user_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_identifier_idx on public.login_attempts(identifier_hash,created_at desc);
create index if not exists login_attempts_ip_idx on public.login_attempts(ip_hash,created_at desc);

create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  severity text not null default 'info' check(severity in ('info','warning','critical')),
  actor_id uuid,
  subject text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists security_events_created_idx on public.security_events(created_at desc);

create table if not exists public.ai_daily_summaries (
  summary_date date primary key,
  summary text not null,
  metrics jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  generated_by uuid
);

create table if not exists public.backup_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null unique,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists backup_snapshots_created_idx on public.backup_snapshots(created_at desc);

create or replace view public.daily_ops_metrics with (security_invoker=true) as
select
  (now() at time zone 'Asia/Amman')::date as business_date,
  count(*) filter(where (created_at at time zone 'Asia/Amman')::date=(now() at time zone 'Asia/Amman')::date) as created_today,
  count(*) filter(where status='delivered' and (delivered_at at time zone 'Asia/Amman')::date=(now() at time zone 'Asia/Amman')::date) as delivered_today,
  count(*) filter(where status in ('returned_store','returned_warehouse','rejected') and (coalesce(returned_at,updated_at) at time zone 'Asia/Amman')::date=(now() at time zone 'Asia/Amman')::date) as problems_today,
  count(*) filter(where status='in_warehouse') as in_warehouse_now,
  count(*) filter(where status in ('assigned','out_for_delivery','postponed','no_answer')) as with_captains_now,
  coalesce(sum(amount_to_collect) filter(where status='delivered' and payment_type='cod' and (delivered_at at time zone 'Asia/Amman')::date=(now() at time zone 'Asia/Amman')::date),0)::numeric(12,2) as collections_today,
  coalesce(sum(delivery_fee) filter(where status='delivered' and (delivered_at at time zone 'Asia/Amman')::date=(now() at time zone 'Asia/Amman')::date),0)::numeric(12,2) as delivery_fees_today
from public.orders;

create or replace function public.system_health_status()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r jsonb;
begin
  if public.current_user_role()<>'admin' then raise exception 'ADMIN_ONLY'; end if;
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
revoke all on function public.system_health_status() from public,anon;
grant execute on function public.system_health_status() to authenticated;

create or replace function public.ops_command_search(p_query text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare q text:=trim(coalesce(p_query,'')); result jsonb;
begin
  if public.current_user_role() not in ('admin','accountant','warehouse') then raise exception 'NOT_ALLOWED'; end if;
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
revoke all on function public.ops_command_search(text) from public,anon;
grant execute on function public.ops_command_search(text) to authenticated;

create or replace function public.create_daily_snapshot(p_date date default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  d date:=coalesce(p_date,(now() at time zone 'Asia/Amman')::date);
  v_id uuid;
begin
  if auth.uid() is not null and public.current_user_role()<>'admin' then raise exception 'ADMIN_ONLY'; end if;

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
revoke all on function public.create_daily_snapshot(date) from public,anon;
grant execute on function public.create_daily_snapshot(date) to authenticated;

alter table public.security_settings enable row level security;
alter table public.login_attempts enable row level security;
alter table public.security_events enable row level security;
alter table public.ai_daily_summaries enable row level security;
alter table public.backup_snapshots enable row level security;

revoke all on public.security_settings,public.login_attempts,public.security_events,public.ai_daily_summaries,public.backup_snapshots from anon;
grant select,update on public.security_settings to authenticated;
grant select on public.security_events,public.ai_daily_summaries,public.backup_snapshots to authenticated;
grant insert,update on public.ai_daily_summaries to authenticated;

drop policy if exists security_settings_read on public.security_settings;
create policy security_settings_read on public.security_settings for select to authenticated using(public.is_admin());
drop policy if exists security_settings_update on public.security_settings;
create policy security_settings_update on public.security_settings for update to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists security_events_read on public.security_events;
create policy security_events_read on public.security_events for select to authenticated using(public.is_admin());

drop policy if exists ai_daily_read on public.ai_daily_summaries;
create policy ai_daily_read on public.ai_daily_summaries for select to authenticated using(public.current_user_role() in ('admin','accountant'));
drop policy if exists ai_daily_admin_write on public.ai_daily_summaries;
create policy ai_daily_admin_write on public.ai_daily_summaries for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists backup_admin_read on public.backup_snapshots;
create policy backup_admin_read on public.backup_snapshots for select to authenticated using(public.is_admin());

-- Logical daily backup job. This is an in-database recovery snapshot, not a substitute for an offsite database backup.
create extension if not exists pg_cron;
do $$
declare jid bigint;
begin
  for jid in select jobid from cron.job where jobname='dropoff-logical-backup' loop
    perform cron.unschedule(jid);
  end loop;
  perform cron.schedule('dropoff-logical-backup','10 1 * * *','select public.create_daily_snapshot();');
end $$;
