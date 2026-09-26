-- Performance follow-up for the captain workforce suite.
-- Cache auth lookups once per statement, keep one UPDATE policy per table,
-- and index the referencing side of every new foreign key.

create index captain_workforce_settings_updated_by_idx on public.captain_workforce_settings(updated_by);
create index captain_overtime_reviews_reviewed_by_idx on public.captain_overtime_reviews(reviewed_by);
create index captain_leave_requests_reviewed_by_idx on public.captain_leave_requests(reviewed_by);
create index captain_payroll_adjustments_created_by_idx on public.captain_payroll_adjustments(created_by);
create index captain_payroll_closures_locked_by_idx on public.captain_payroll_closures(locked_by);
create index captain_payroll_closures_paid_by_idx on public.captain_payroll_closures(paid_by);

drop policy workforce_settings_read on public.captain_workforce_settings;
drop policy workforce_settings_update on public.captain_workforce_settings;
create policy workforce_settings_read on public.captain_workforce_settings for select to authenticated using (
  (select public.current_user_role()) in ('admin','accountant','pickup_captain','delivery_captain')
);
create policy workforce_settings_update on public.captain_workforce_settings for update to authenticated
  using ((select public.finance_access())) with check ((select public.finance_access()));

drop policy overtime_read on public.captain_overtime_reviews;
drop policy overtime_add on public.captain_overtime_reviews;
drop policy overtime_update on public.captain_overtime_reviews;
drop policy overtime_admin_delete on public.captain_overtime_reviews;
create policy overtime_read on public.captain_overtime_reviews for select to authenticated using (
  (select public.finance_access()) or exists(
    select 1 from public.captain_shifts s where s.id=shift_id and s.captain_id=(select auth.uid())
  )
);
create policy overtime_add on public.captain_overtime_reviews for insert to authenticated with check (
  (select public.finance_access()) and reviewed_by=(select auth.uid())
);
create policy overtime_update on public.captain_overtime_reviews for update to authenticated
  using ((select public.finance_access()))
  with check ((select public.finance_access()) and reviewed_by=(select auth.uid()));
create policy overtime_admin_delete on public.captain_overtime_reviews for delete to authenticated using (
  (select public.current_user_role())='admin'
);

drop policy leaves_read on public.captain_leave_requests;
drop policy leaves_add on public.captain_leave_requests;
drop policy leaves_captain_cancel on public.captain_leave_requests;
drop policy leaves_finance_review on public.captain_leave_requests;
create policy leaves_read on public.captain_leave_requests for select to authenticated using (
  captain_id=(select auth.uid()) or (select public.finance_access())
);
create policy leaves_add on public.captain_leave_requests for insert to authenticated with check (
  captain_id=(select auth.uid()) and status='pending'
);
create policy leaves_update on public.captain_leave_requests for update to authenticated using (
  (captain_id=(select auth.uid()) and status='pending') or (select public.finance_access())
) with check (
  captain_id=(select auth.uid()) or (select public.finance_access())
);

drop policy adjustments_read on public.captain_payroll_adjustments;
drop policy adjustments_add on public.captain_payroll_adjustments;
drop policy adjustments_admin_delete on public.captain_payroll_adjustments;
create policy adjustments_read on public.captain_payroll_adjustments for select to authenticated using (
  captain_id=(select auth.uid()) or (select public.finance_access())
);
create policy adjustments_add on public.captain_payroll_adjustments for insert to authenticated with check (
  (select public.finance_access()) and created_by=(select auth.uid())
);
create policy adjustments_admin_delete on public.captain_payroll_adjustments for delete to authenticated using (
  (select public.current_user_role())='admin'
);

drop policy closures_read on public.captain_payroll_closures;
drop policy closures_add on public.captain_payroll_closures;
drop policy closures_finance_update on public.captain_payroll_closures;
drop policy closures_captain_ack on public.captain_payroll_closures;
drop policy closures_admin_delete on public.captain_payroll_closures;
create policy closures_read on public.captain_payroll_closures for select to authenticated using (
  captain_id=(select auth.uid()) or (select public.finance_access())
);
create policy closures_add on public.captain_payroll_closures for insert to authenticated with check (
  (select public.finance_access()) and locked_by=(select auth.uid())
);
create policy closures_update on public.captain_payroll_closures for update to authenticated using (
  (select public.finance_access()) or (captain_id=(select auth.uid()) and paid_at is not null)
) with check (
  (select public.finance_access()) or captain_id=(select auth.uid())
);
create policy closures_admin_delete on public.captain_payroll_closures for delete to authenticated using (
  (select public.current_user_role())='admin' and paid_at is null
);

drop policy payroll_audit_read on public.captain_payroll_audit_logs;
create policy payroll_audit_read on public.captain_payroll_audit_logs for select to authenticated using (
  (select public.finance_access())
);

-- A zero-net payroll can still be acknowledged without attempting to insert
-- an accounting expense that violates accounting_expenses.amount > 0.
create or replace function public.pay_captain_salary(p_closure_id uuid,p_method text default 'cash',p_reference text default null)
returns public.captain_payroll_closures language plpgsql security invoker set search_path=public as $$
declare v_row public.captain_payroll_closures;v_name text;
begin
  if not public.finance_access() then raise exception 'غير مخوّل'; end if;
  if p_method not in ('cash','bank') then raise exception 'طريقة الدفع غير صحيحة'; end if;
  update public.captain_payroll_closures set paid_at=now(),payment_method=p_method,payment_reference=nullif(trim(p_reference),'')
    where id=p_closure_id and paid_at is null returning * into v_row;
  if v_row.id is null then raise exception 'الراتب غير موجود أو مدفوع مسبقاً'; end if;
  if v_row.net_amount>0 then
    select full_name into v_name from public.profiles where id=v_row.captain_id;
    insert into public.accounting_expenses(amount,method,category,note,spent_at,created_by)
      values(v_row.net_amount,p_method,'salary','راتب '||coalesce(v_name,'كابتن')||' - '||to_char(v_row.payroll_month,'YYYY-MM'),now(),auth.uid());
  end if;
  return v_row;
end $$;
revoke all on function public.pay_captain_salary(uuid,text,text) from public,anon;
grant execute on function public.pay_captain_salary(uuid,text,text) to authenticated;
