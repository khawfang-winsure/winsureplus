-- 0060: สร้าง view แนวโน้มหนี้ค้าง/หนี้เสียรายเดือน (ใช้ใน Exec Dashboard trend chart)
-- คืน 1 แถวต่อเดือน (12 เดือนล่าสุด) พร้อม count+value ของ 2 กลุ่ม:
--   overdue  = สัญญา active ที่มีงวดค้างอยู่ ณ สิ้นเดือน M (days_late≥1)
--   bad_debt = สัญญา active ที่ค้างนานที่สุดเกิน 60 วัน ณ สิ้นเดือน M (days_late≥60)
-- หมายเหตุ: paid_amount เป็นค่าปัจจุบัน (snapshot ณ ขณะนี้) — ยอมรับประมาณการ
--           status='active' ณ ปัจจุบัน (undercount เดือนเก่าเล็กน้อย — ยอมรับ)

-- ============================================================================
-- SECTION 1: สร้าง view
-- ============================================================================

drop view if exists public.v_overdue_month_snapshot;

create view public.v_overdue_month_snapshot as
with

-- 1) สร้างชุด end-of-month 12 เดือนล่าสุด (รวมเดือนปัจจุบัน)
months as (
  select
    -- date_trunc month ตั้งแต่ 11 เดือนก่อน ถึงเดือนปัจจุบัน
    (date_trunc('month', current_date) - make_interval(months => m))::date as month_start,
    -- สิ้นเดือน = min(สิ้นเดือนจริง, current_date) → กันนับงวดอนาคตในเดือนที่ยังไม่จบ
    least(
      ((date_trunc('month', current_date) - make_interval(months => m))
        + interval '1 month - 1 day')::date,
      current_date
    )::date                                                                   as end_of_month
  from generate_series(0, 11) as m
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
    -- งวดค้างอยู่ ณ สิ้นเดือน M
    count(i.id)                                                             as unpaid_count_at_m,
    -- งวดที่เก่าที่สุด (เพื่อคำนวณ days_late)
    min(i.due_date)                                                         as oldest_due_at_m,
    -- ยอดค้าง ณ M = Σ (amount - paid_amount ปัจจุบัน)  — ประมาณการ
    coalesce(
      sum(i.amount - coalesce(i.paid_amount, 0)),
      0
    )                                                                       as overdue_amount_at_m
  from months m
  cross join active_contracts ac
  -- left join เพื่อให้สัญญาที่ไม่มีงวดค้างก็ยังมีแถว (unpaid_count=0)
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

-- 5) GROUP BY เดือน → 12 แถว
select
  month_start                                                               as snapshot_month,
  -- overdue: days_late>=1 (มีงวดค้างอยู่จริง)
  count(*) filter (where days_late_at_m >= 1)::int                         as overdue_count,
  coalesce(
    sum(overdue_amount_at_m) filter (where days_late_at_m >= 1),
    0
  )::numeric                                                                as overdue_amount,
  -- bad_debt: days_late>=60
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

-- 1) ดู 12 แถว เรียงจากเก่าไปใหม่:
-- select snapshot_month, overdue_count, overdue_amount, bad_count, bad_amount
--   from public.v_overdue_month_snapshot
--   order by snapshot_month;
-- expected: 12 แถว, snapshot_month ล่าสุด = วันที่ 1 ของเดือนปัจจุบัน

-- 2) เดือนล่าสุด ≈ v_contract_status (active, days_late≥1):
-- select count(*) from public.v_contract_status where status='active' and days_late>=1;
-- เทียบกับ overdue_count เดือนล่าสุดใน v_overdue_month_snapshot
-- (ควรใกล้เคียงกัน — ต่างเล็กน้อยได้เพราะ pending_documents suppress ใน v_contract_status)

-- 3) เดือนล่าสุด bad_count ≈ v_contract_status (active, days_late≥60):
-- select count(*) from public.v_contract_status where status='active' and days_late>=60;
-- เทียบกับ bad_count เดือนล่าสุด

-- 4) overdue_amount เดือนล่าสุด ≈ Σ overdue_amount ใน v_contract_status (active):
-- select sum(overdue_amount) from public.v_contract_status where status='active';
-- เทียบกับ overdue_amount เดือนล่าสุด

-- 5) grants ครบ:
-- select has_table_privilege('authenticated', 'public.v_overdue_month_snapshot', 'SELECT');
-- select has_table_privilege('service_role',  'public.v_overdue_month_snapshot', 'SELECT');
-- expected: true ทั้งคู่
