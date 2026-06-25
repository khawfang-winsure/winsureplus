-- 0061: ขยาย v_overdue_month_snapshot ให้ครอบคลุมทุกเดือนตั้งแต่ due_date แรกสุดจนถึงปัจจุบัน
-- (แทนแค่ 12 เดือนล่าสุด) เพื่อรองรับ dropdown เลือกปีในกราฟแนวโน้มหนี้ /exec

-- ============================================================================
-- SECTION 1: สร้าง view (replace ของเดิม — ชื่อ/คอลัมน์ไม่เปลี่ยน)
-- ============================================================================

drop view if exists public.v_overdue_month_snapshot;

create view public.v_overdue_month_snapshot as
with

-- 1) สร้างชุด month_start ตั้งแต่เดือนแรกที่มี due_date จนถึงเดือนปัจจุบัน
months as (
  select
    gs::date as month_start,
    -- สิ้นเดือน = min(สิ้นเดือนจริง, current_date) → กันนับงวดอนาคตในเดือนที่ยังไม่จบ
    least(
      (gs + interval '1 month - 1 day')::date,
      current_date
    )::date as end_of_month
  from generate_series(
    date_trunc('month', (select min(due_date) from public.installments)),
    date_trunc('month', current_date),
    interval '1 month'
  ) as gs
),

-- 2) สัญญา active (snapshot ปัจจุบัน)
active_contracts as (
  select id as contract_id, monthly_payment
  from public.contracts
  where status = 'active'
),

-- 3) cross join contracts × months แล้ว aggregate ครั้งเดียว
--    "งวดค้างอยู่ ณ สิ้นเดือน M" = due_date <= eom AND (paid_at IS NULL OR paid_at > eom)
contract_month_agg as (
  select
    m.month_start,
    m.end_of_month,
    ac.contract_id,
    count(i.id)                                                             as unpaid_count_at_m,
    min(i.due_date)                                                         as oldest_due_at_m,
    coalesce(
      sum(i.amount - coalesce(i.paid_amount, 0)),
      0
    )                                                                       as overdue_amount_at_m
  from months m
  cross join active_contracts ac
  left join public.installments i
    on  i.contract_id = ac.contract_id
    and i.due_date    <= m.end_of_month
    and (i.paid_at is null or i.paid_at > m.end_of_month)
  group by m.month_start, m.end_of_month, ac.contract_id
),

-- 4) คำนวณ days_late ต่อ (contract, month)
contract_month_status as (
  select
    month_start,
    end_of_month,
    contract_id,
    unpaid_count_at_m,
    overdue_amount_at_m,
    case
      when unpaid_count_at_m = 0 or oldest_due_at_m is null then 0
      else greatest(0, (end_of_month - oldest_due_at_m))
    end                                                                     as days_late_at_m
  from contract_month_agg
)

-- 5) GROUP BY เดือน → N แถว (ครอบคลุมทุกเดือนตั้งแต่เริ่มมีข้อมูล)
select
  month_start                                                               as snapshot_month,
  count(*) filter (where days_late_at_m >= 1)::int                         as overdue_count,
  coalesce(
    sum(overdue_amount_at_m) filter (where days_late_at_m >= 1),
    0
  )::numeric                                                                as overdue_amount,
  count(*) filter (where days_late_at_m >= 60)::int                        as bad_count,
  coalesce(
    sum(overdue_amount_at_m) filter (where days_late_at_m >= 60),
    0
  )::numeric                                                                as bad_amount
from contract_month_status
group by month_start
order by month_start;

-- ============================================================================
-- SECTION 2: GRANT
-- (views ไม่รับ default privileges จาก 0017 — ต้อง grant ตรงเสมอ)
-- ============================================================================

grant select on public.v_overdue_month_snapshot to authenticated;
grant select on public.v_overdue_month_snapshot to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply
-- ============================================================================

-- 1) ดูทุกแถว เรียงจากเก่าไปใหม่ — ต้องได้มากกว่า 12 แถว (เริ่มจาก 2025-04-01):
-- select snapshot_month, overdue_count, overdue_amount, bad_count, bad_amount
--   from public.v_overdue_month_snapshot
--   order by snapshot_month;
-- expected: แถวแรก = 2025-04-01 (หรือใกล้เคียงตาม min due_date จริง)
-- expected: แถวสุดท้าย = date_trunc('month', current_date) = 2026-06-01

-- 2) นับจำนวนแถว:
-- select count(*) from public.v_overdue_month_snapshot;
-- expected: ≈ 15 แถว (2025-04 → 2026-06 = 15 เดือน) — ปรับตาม min due_date จริง

-- 3) เดือนล่าสุด ≈ v_contract_status (active, days_late≥1):
-- select count(*) from public.v_contract_status where status='active' and days_late>=1;
-- เทียบกับ overdue_count เดือนล่าสุดใน v_overdue_month_snapshot

-- 4) grants ครบ:
-- select has_table_privilege('authenticated', 'public.v_overdue_month_snapshot', 'SELECT');
-- select has_table_privilege('service_role',  'public.v_overdue_month_snapshot', 'SELECT');
-- expected: true ทั้งคู่
