-- Drop Off captain payroll policy:
-- fixed monthly salary, Friday rest day, 08:00-17:00, overtime at 1.25x,
-- and a daily phone/charging allowance for each completed attendance day.
alter table public.captain_pay_rates
  alter column hourly_rate drop not null,
  add column monthly_salary numeric(12,2) not null default 450,
  add column daily_allowance numeric(12,2) not null default 5,
  add column workday_start time not null default '08:00',
  add column workday_end time not null default '17:00',
  add column overtime_multiplier numeric(6,3) not null default 1.25,
  add constraint captain_monthly_salary_range check(monthly_salary between 0 and 10000),
  add constraint captain_daily_allowance_range check(daily_allowance between 0 and 1000),
  add constraint captain_overtime_multiplier_range check(overtime_multiplier between 0 and 10),
  add constraint captain_workday_order check(workday_end > workday_start);

comment on column public.captain_pay_rates.hourly_rate is 'Legacy field retained for compatibility; monthly payroll uses monthly_salary.';
comment on column public.captain_pay_rates.monthly_salary is 'Fixed monthly salary. Absences are shown but do not automatically reduce it.';
comment on column public.captain_pay_rates.daily_allowance is 'Paid once per completed attendance day.';
comment on column public.captain_pay_rates.overtime_multiplier is 'Applied after workday_end; approved policy is 1.25.';

grant update(monthly_salary,daily_allowance) on public.captain_pay_rates to authenticated;
