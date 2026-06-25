-- 0058: เพิ่ม 2 views รวมยอดงวดรายเดือน (แก้ PAGE_CAP ใน /exec — ตัวเลข expectedThisMonth/Next + forecast)

-- ============================================================================
-- SECTION 1: v_due_schedule_monthly
-- รวมยอดงวดต่อเดือน (เฉพาะสัญญา active) — aggregate ข้ามสัญญา → ~24-36 แถวตลอดชีพ
-- ใช้แทน raw installments scan ใน execDashboard expectedThisMonth/expectedNextMonth
-- ============================================================================

create or replace view public.v_due_schedule_monthly as
select
  date_trunc('month', i.due_date)::date                                            as due_month,
  coalesce(sum(i.amount), 0)                                                       as scheduled_amount,
  coalesce(sum(i.paid_amount) filter (where i.paid_at is not null), 0)             as collected_amount,
  coalesce(sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0))
           filter (where i.paid_at is null), 0)                                    as remaining_amount,
  count(i.id)                                                                      as total_count,
  count(i.id) filter (where i.paid_at is not null)                                as paid_count
from public.installments i
join public.contracts c on c.id = i.contract_id
where c.status = 'active'
group by date_trunc('month', i.due_date);

-- ============================================================================
-- SECTION 2: v_forecast_monthly_by_grade
-- ยอดงวดที่ยังไม่จ่าย (อนาคต) แยกตาม due_month + bucket grade จาก v_contract_status
-- ใช้แทน raw installments scan ใน forecast chart — ~60 แถว (เดือน × grade)
-- ============================================================================

create or replace view public.v_forecast_monthly_by_grade as
select
  date_trunc('month', i.due_date)::date                                            as due_month,
  coalesce(vs.grade, 'unknown')                                                    as grade,
  coalesce(sum(i.amount), 0)                                                       as expected_amount,
  count(i.id)                                                                      as installment_count
from public.installments i
join public.contracts c on c.id = i.contract_id
left join public.v_contract_status vs on vs.contract_id = c.id
where
  c.status = 'active'
  and i.paid_at is null
  and i.due_date >= current_date
group by date_trunc('month', i.due_date), coalesce(vs.grade, 'unknown');

-- ============================================================================
-- SECTION 3: GRANT
-- (0017 default privileges ไม่ครอบ views ต้อง grant ตรงเสมอ)
-- ============================================================================

grant select on public.v_due_schedule_monthly      to authenticated, service_role;
grant select on public.v_forecast_monthly_by_grade to authenticated, service_role;

-- verify หลัง apply:
-- select has_table_privilege('service_role', 'public.v_due_schedule_monthly', 'SELECT');
-- select has_table_privilege('service_role', 'public.v_forecast_monthly_by_grade', 'SELECT');
-- select sum(scheduled_amount) from v_due_schedule_monthly;
-- select sum(amount) from installments i join contracts c on c.id=i.contract_id where c.status='active';
-- select sum(expected_amount) from v_forecast_monthly_by_grade;
-- select sum(i.amount) from installments i join contracts c on c.id=i.contract_id where c.status='active' and i.paid_at is null and i.due_date>=current_date;
