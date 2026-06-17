-- 0023: Attribution view สำหรับ promise-kept rate (7-day window, split-equally) + aggregate grade counts

-- ============================================================================
-- SECTION 1: v_promise_attribution_30d
-- ============================================================================
-- คำนวณ promises ที่ freelancer INSERT ใน 30 วันที่ผ่านมา (follow_up_result='promised' + next_follow_up_at not null)
-- ตรวจว่ามี payment_log ที่ action='pay' บน contract เดียวกัน ภายใน 7 วันหลัง next_follow_up_at
--
-- Split-equally tie-breaker:
--   ถ้า freelancer หลายคน promise บน contract เดียวกัน + next_follow_up_at ในวันเดียวกัน (±1 วัน buffer)
--   → credit_share = 1 / N ต่อคน
--
-- หมายเหตุ: payment_log ไม่มี column paid_at
--   ใช้ created_at (timestamptz default now() เมื่อ insert — set ตอนจ่ายจริง)
--
-- security_invoker=on: RLS follow_ups_read + payment_log_read apply ตาม caller's role
--   admin/staff: เห็นทุก row
--   freelancer: เห็นเฉพาะ in-grade contracts (follow_ups_read ใน 0018)
--   payment_log_read (0018): admin + staff เท่านั้น — freelancer ไม่เห็น payment_log
--   → attribution query นี้ใช้สำหรับ admin/staff ใน performance dashboard (ไม่ใช่ freelancer)
-- ============================================================================

create or replace view public.v_promise_attribution_30d
  with (security_invoker = on) as
with promises as (
  -- ทุก promise ใน 30 วันที่ผ่านมา ที่มี next_follow_up_at not null
  select
    f.id as follow_up_id,
    f.contract_id,
    f.author_id,
    f.next_follow_up_at,
    -- credit_share = 1 / N freelancers ที่ promise บน contract+window เดียวกัน (±1 วัน buffer)
    (
      select 1.0 / count(distinct f2.author_id)::numeric
      from public.follow_ups f2
      where f2.contract_id = f.contract_id
        and f2.follow_up_result = 'promised'
        and f2.next_follow_up_at is not null
        and f2.next_follow_up_at::date between (f.next_follow_up_at::date - interval '1 day')
                                           and (f.next_follow_up_at::date + interval '1 day')
    ) as credit_share
  from public.follow_ups f
  where f.follow_up_result = 'promised'
    and f.next_follow_up_at is not null
    and f.created_at >= now() - interval '30 days'
),
kept as (
  -- ตรวจ payment_log บน contract เดียวกัน ภายใน 7 วันหลัง next_follow_up_at
  -- payment_log.created_at = เวลาที่ insert (= เวลาจ่ายจริง เพราะ record_payment ใส่ now())
  select
    p.follow_up_id,
    p.contract_id,
    p.author_id,
    p.credit_share,
    exists (
      select 1
      from public.payment_log pl
      where pl.contract_id = p.contract_id
        and pl.action = 'pay'
        and pl.created_at >= p.next_follow_up_at
        and pl.created_at <  p.next_follow_up_at + interval '7 days'
    ) as kept
  from promises p
)
select
  author_id,
  count(*) filter (where kept)::int                          as promises_kept_count,
  sum(case when kept then credit_share else 0.0 end)         as promises_kept_credit,
  count(*)::int                                               as promises_total
from kept
group by author_id;

grant select on public.v_promise_attribution_30d to authenticated, service_role;

-- ============================================================================
-- SECTION 2: v_grade_active_counts
-- ============================================================================
-- Count ของสัญญา active ต่อ grade (A-E) — สำหรับ totalAssigned per freelancer
-- แทนการ SELECT * FROM contracts แล้ว count ฝั่ง client (ซึ่งติด PostgREST 1000-row cap)
-- คืน ≤6 rows (null + A-E) → ปลอดภัยจาก row-cap
--
-- security_invoker=on: contracts_read RLS apply ตาม caller's role
--   admin/staff: เห็นทุก active contract → count ถูกต้องสำหรับ performance dashboard
-- ============================================================================

create or replace view public.v_grade_active_counts
  with (security_invoker = on) as
select
  current_grade,
  count(*)::int as contract_count
from public.contracts
where status = 'active'
  and current_grade is not null
group by current_grade;

grant select on public.v_grade_active_counts to authenticated, service_role;

-- ============================================================================
-- SECTION 3: v_grade_escalate_counts
-- ============================================================================
-- Count ของสัญญา ESCALATE (totalAttempts ≥ 10 AND successfulAttempts = 0 ใน 90 วัน)
-- ต่อ grade — สำหรับ escalateContracts per freelancer
-- คืน ≤6 rows → ปลอดภัยจาก row-cap
--
-- security_invoker=on: v_follow_up_stats_90d + contracts_read RLS apply
-- ============================================================================

create or replace view public.v_grade_escalate_counts
  with (security_invoker = on) as
select
  c.current_grade,
  count(*)::int as escalate_count
from public.v_follow_up_stats_90d s
join public.contracts c on c.id = s.contract_id
where s.total_attempts >= 10
  and s.successful_attempts = 0
  and c.status = 'active'
  and c.current_grade is not null
group by c.current_grade;

grant select on public.v_grade_escalate_counts to authenticated, service_role;

-- ============================================================================
-- SECTION 4: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 4a) ตรวจ views มีอยู่ + service_role เข้าถึงได้:
-- SELECT has_table_privilege('service_role', 'public.v_promise_attribution_30d', 'SELECT');
--   expected: true
-- SELECT has_table_privilege('authenticated', 'public.v_promise_attribution_30d', 'SELECT');
--   expected: true
-- SELECT has_table_privilege('service_role', 'public.v_grade_active_counts', 'SELECT');
--   expected: true
-- SELECT has_table_privilege('service_role', 'public.v_grade_escalate_counts', 'SELECT');
--   expected: true

-- 4b) ตรวจ view คืนข้อมูลได้ (ไม่ error):
-- SELECT * FROM public.v_promise_attribution_30d LIMIT 5;
-- SELECT * FROM public.v_grade_active_counts;
-- SELECT * FROM public.v_grade_escalate_counts;
