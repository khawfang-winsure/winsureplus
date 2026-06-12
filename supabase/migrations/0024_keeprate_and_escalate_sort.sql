-- 0024: แก้ไข Keep Rate ให้ใช้ payment-anchored 5-day window + เพิ่ม est_outstanding ใน v_contract_status
-- Pete locked 2026-06-13
--
-- Fix #2: v_promise_attribution_30d — เปลี่ยนจาก promise-anchored 7-day → payment-anchored 5-day
--   numerator: ฟรีแลนซ์ที่ promised บน contract เดียวกัน ใน [paid_date-5d, paid_date]
--   denominator: promises_total เหมือนเดิม (OQ-A Pete locked ไม่เปลี่ยน)
--   ✓ Fix #5 (ติ๊ก review round 2): aggregate at promise level — promise 1 อันได้ credit สูงสุด 1 ครั้ง
--      ไม่ว่าจะมี payment กี่ครั้ง (กัน 1 promise → 2 payments → rate 200%)
--      guarantee: numerator promise-set ⊆ denominator promise-set → ratio ≤ 100% เสมอ
--
-- Fix #3: v_contract_status — เพิ่ม est_outstanding = monthly_payment × remaining_installments
--   เป็น sort key สำหรับ ESCALATE widget (แทน penalty_due ซึ่งมี cap ~700 บาท)

-- ============================================================================
-- SECTION 1: Drop + recreate v_promise_attribution_30d
-- ============================================================================
-- เหตุที่ drop แทน create or replace: security_invoker ไม่สามารถ alter ได้ — ต้อง drop+create
-- ไม่มี view อื่น depend บน v_promise_attribution_30d (ตรวจ migration 0001-0023 แล้ว)
-- ============================================================================

drop view if exists public.v_promise_attribution_30d;

create view public.v_promise_attribution_30d
  with (security_invoker = on) as
with paid_events as (
  -- payment events ใน 30 วันล่าสุด (dedup by contract+date เพื่อกัน double-count
  --   กรณีชำระหลายงวดในวันเดียวกัน — นับ 1 event ต่อ contract ต่อ paid_date)
  select distinct
    pl.contract_id,
    (pl.created_at at time zone 'Asia/Bangkok')::date as paid_date
  from public.payment_log pl
  where pl.action = 'pay'
    and pl.created_at >= now() - interval '30 days'
),
co_counts as (
  -- นับ distinct author per (contract_id, paid_date) ก่อน
  -- แยก CTE เพราะ Postgres ไม่รองรับ COUNT(DISTINCT) OVER() (SQLSTATE 0A000)
  -- predicate ต้องตรงกับ window_contacts ทุกบรรทัด (กัน denominator drift)
  select
    pe.contract_id,
    pe.paid_date,
    count(distinct f.author_id) as co_author_count
  from paid_events pe
  join public.follow_ups f
    on f.contract_id = pe.contract_id
    and f.follow_up_result = 'promised'
    and f.next_follow_up_at is not null                        -- match denominator (promises_agg)
    and f.created_at >= now() - interval '30 days'             -- match denominator (promises_agg)
    and (f.created_at at time zone 'Asia/Bangkok')::date
        between (pe.paid_date - interval '5 days')::date and pe.paid_date
  join public.profiles pr
    on pr.id = f.author_id
    and pr.role = 'freelancer'
  group by pe.contract_id, pe.paid_date
),
window_contacts as (
  -- หา freelancer ที่ promised บน contract เดียวกัน
  -- ใน window [paid_date - 5 วัน, paid_date]
  -- credit_share = 1/N แบ่งเท่ากันถ้าหลายคน promised บน contract+paid_date เดียวกัน
  -- เพิ่ม f.id as promise_id เพื่อระบุตัว promise (ใช้ใน promise_credits)
  select
    pe.contract_id,
    pe.paid_date,
    f.id      as promise_id,
    f.author_id,
    1.0 / cc.co_author_count as credit_share                  -- join CTE แทน window (no DISTINCT in window)
  from paid_events pe
  join co_counts cc
    on cc.contract_id = pe.contract_id
    and cc.paid_date = pe.paid_date
  join public.follow_ups f
    on f.contract_id = pe.contract_id
    and f.follow_up_result = 'promised'
    and f.next_follow_up_at is not null                        -- match denominator (promises_agg)
    and f.created_at >= now() - interval '30 days'             -- match denominator (promises_agg)
    and (f.created_at at time zone 'Asia/Bangkok')::date
        between (pe.paid_date - interval '5 days')::date and pe.paid_date
  join public.profiles pr
    on pr.id = f.author_id
    and pr.role = 'freelancer'
),
promise_credits as (
  -- aggregate ที่ระดับ promise (ไม่ใช่ contract+paid_date)
  -- 1 promise ได้ credit สูงสุด 1 ครั้ง ไม่ว่าจะมี payment กี่รอบใน 5-day window
  -- max(credit_share): promise เดียวกันอาจ match หลาย paid_date ที่มีชุด co-author ต่างกัน
  --   → credit_share ต่าง row อาจไม่เท่ากัน → max เลือกค่าสูงสุด (อย่างมาก 1.0/promise)
  --   → ยังการันตี ≤1.0 ต่อ promise → ratio ≤ 100% เสมอ
  select
    promise_id,
    author_id,
    max(credit_share) as credit_share
  from window_contacts
  group by promise_id, author_id
),
credit_agg as (
  -- รวม credit ต่อ author_id (จาก promise_credits แทน freelancer_credits เดิม)
  select
    author_id,
    count(*)::int                    as promises_kept_count,
    sum(credit_share)::numeric(10,2) as promises_kept_credit
  from promise_credits
  group by author_id
),
promises_agg as (
  -- denominator: promises ทั้งหมดใน 30 วัน ที่มี next_follow_up_at (OQ-A ไม่เปลี่ยน)
  select
    f.author_id,
    count(*)::int as promises_total
  from public.follow_ups f
  join public.profiles pr on pr.id = f.author_id and pr.role = 'freelancer'
  where f.follow_up_result = 'promised'
    and f.next_follow_up_at is not null
    and f.created_at >= now() - interval '30 days'
  group by f.author_id
)
-- FULL OUTER JOIN: กัน freelancer ที่มี promises แต่ไม่มี credit (หรือกลับกัน) หายไป
select
  coalesce(c.author_id, p.author_id)                        as author_id,
  coalesce(c.promises_kept_count, 0)                        as promises_kept_count,
  coalesce(c.promises_kept_credit, 0::numeric(10,2))        as promises_kept_credit,
  coalesce(p.promises_total, 0)                             as promises_total
from credit_agg c
full outer join promises_agg p on p.author_id = c.author_id;

-- restore grants (drop view loses all grants)
grant select on public.v_promise_attribution_30d to authenticated;
grant select on public.v_promise_attribution_30d to service_role;

-- ============================================================================
-- SECTION 2: Drop + recreate v_contract_status + est_outstanding column
-- ============================================================================
-- ⚠️ ต้อง preserve:
--   1. security_invoker = on (critical สำหรับ freelancer RLS — จาก 0018)
--   2. grade column (จาก 0018)
--   3. JOIN shops_basic ไม่ใช่ shops (จาก 0018 Fix 4)
--   4. ทุก column เดิม (ห้ามลบ)
-- เพิ่มใหม่: est_outstanding = monthly_payment × remaining_installments
--   เป็น sort key จริงสำหรับ ESCALATE (แทน penalty_due ที่มี cap 700 บาท)
--
-- ตรวจ dependency: ไม่มี view อื่น SELECT จาก v_contract_status ใน migrations 0001-0023
-- ============================================================================

drop view if exists public.v_contract_status;

create view public.v_contract_status
  with (security_invoker = on) as
with agg as (
  select
    i.contract_id,
    min(i.due_date) filter (where i.paid_at is null) as next_due,
    coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0) as penalty_due,
    count(*) filter (where i.paid_at is null) as remaining_installments
  from installments i
  group by i.contract_id
)
select
  c.id as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name as shop_name,
  c.status,
  a.next_due,
  coalesce(a.remaining_installments, 0) as remaining_installments,
  coalesce(a.penalty_due, 0)            as penalty_due,
  case
    when c.status <> 'active' or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end as days_late,
  case
    when c.status <> 'active' or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10  then '1-10'
    when current_date - a.next_due <= 30  then '11-30'
    when current_date - a.next_due <= 60  then '31-60'
    when current_date - a.next_due <= 90  then '61-90'
    when current_date - a.next_due <= 120 then '91-120'
    else '120+'
  end as bucket,
  -- grade column (from 0018 — RLS uses contracts.current_grade directly, not this)
  grade_for_days_late(
    case
      when c.status <> 'active' or a.next_due is null then 0
      else greatest(0, (current_date - a.next_due))
    end
  ) as grade,
  -- [NEW 0024] est_outstanding: ประมาณยอดคงเหลือจริง สำหรับ ESCALATE sort
  -- ดีกว่า penalty_due (cap ~700 บาท) เพราะสะท้อนภาระหนี้ที่เหลือจริง
  coalesce(c.monthly_payment, 0) * coalesce(a.remaining_installments, 0) as est_outstanding
from contracts c
left join agg a on a.contract_id = c.id
left join shops_basic s on s.id = c.shop_id;

-- restore grants (drop view loses all grants — ดู 0018 §7 pattern)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;    -- YELLOW fix: service_role ต้องอ่าน view ผ่าน Edge Function

-- ============================================================================
-- SECTION 3: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 3a) ตรวจ v_promise_attribution_30d ใหม่ทำงาน + มีทุก column
-- SELECT author_id, promises_kept_count, promises_kept_credit, promises_total
-- FROM public.v_promise_attribution_30d LIMIT 5;
--   expected: ≥0 rows (0 ถ้าไม่มี payment ใน 30 วัน); promises_total อาจ > 0 ถ้ามี follow_up='promised'

-- 3b) ตรวจ est_outstanding มีใน v_contract_status
-- SELECT contract_id, monthly_payment, remaining_installments, est_outstanding
-- FROM public.v_contract_status WHERE est_outstanding > 0 LIMIT 5;
--   expected: est_outstanding = monthly_payment × remaining_installments

-- 3c) ตรวจ security_invoker ยัง = on
-- SELECT relname, reloptions
-- FROM pg_class
-- WHERE relname IN ('v_contract_status','v_promise_attribution_30d');
--   expected: เห็น {security_invoker=on} ใน reloptions ของทั้ง 2 rows

-- 3d) ตรวจ grants
-- SELECT has_table_privilege('service_role', 'public.v_promise_attribution_30d', 'SELECT');
-- SELECT has_table_privilege('authenticated', 'public.v_promise_attribution_30d', 'SELECT');
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role', 'public.v_contract_status', 'SELECT');  -- YELLOW fix
--   expected: true ทุกตัว
