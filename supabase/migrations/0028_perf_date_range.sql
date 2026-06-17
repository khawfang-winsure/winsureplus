-- 0028: Performance Dashboard date-range selector — parameterized functions แทน hard-coded 30d views
-- สร้าง get_freelancer_perf(p_days) + get_promise_attribution(p_days) โดยคงไว้ทั้งสอง views เดิม
-- (views ยังอยู่ — additive only, ไม่ drop)

-- ============================================================================
-- SECTION 1: get_freelancer_perf(p_days int default 30)
-- ============================================================================
-- parameterized version ของ v_freelancer_performance_30d (0022 §3)
-- logic เหมือนกันทุกบรรทัด — เปลี่ยนแค่ interval '30 days' → p_days
--
-- security invoker: caller's RLS apply
--   admin/staff: เห็น follow_ups + contracts ทุก row
--   freelancer: เห็นเฉพาะ in-grade contracts (follow_ups_read ใน 0018)
--
-- p_days clamp [1, 90] ด้วย greatest/least ภายใน body (CHECK บน param ไม่ valid ใน Postgres)
-- ============================================================================

create or replace function public.get_freelancer_perf(p_days int default 30)
returns table (
  author_id          uuid,
  current_grade      text,
  total_attempts     int,
  successful_attempts int,
  promise_count      int,
  resolution_count   int,
  unique_contracts   int,
  last_activity_at   timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    f.author_id,
    c.current_grade,
    count(*)::int                                                                  as total_attempts,
    count(*) filter (
      where f.follow_up_result in ('contacted','promised','paid','returned','other')
    )::int                                                                         as successful_attempts,
    count(*) filter (where f.follow_up_result = 'promised')::int                  as promise_count,
    count(*) filter (
      where f.follow_up_result in ('paid','returned')
    )::int                                                                         as resolution_count,
    count(distinct f.contract_id)::int                                             as unique_contracts,
    max(f.created_at)                                                              as last_activity_at
  from public.follow_ups f
  join public.contracts c on c.id = f.contract_id
  where f.created_at >= now() - (greatest(1, least(90, p_days)) || ' days')::interval
  group by f.author_id, c.current_grade;
$$;

grant execute on function public.get_freelancer_perf(int) to authenticated, service_role;

-- ============================================================================
-- SECTION 2: get_promise_attribution(p_days int default 30)
-- ============================================================================
-- parameterized version ของ v_promise_attribution_30d (0024 §1 — payment-anchored 5-day)
-- logic เหมือนกัน 100% กับ view ใน 0024 — เปลี่ยนแค่ interval '30 days' → p_days ทุก occurrences
--
-- security invoker: RLS ของ follow_ups + payment_log apply ตาม caller's role
--   admin/staff: เห็นทุก row → attribution ถูกต้อง
--   freelancer: ไม่เห็น payment_log (payment_log_read ใน 0018 admin+staff เท่านั้น)
--   → ใช้สำหรับ admin/staff ใน performance dashboard เท่านั้น
--
-- p_days clamp [1, 90] ด้วย greatest/least
-- ============================================================================

create or replace function public.get_promise_attribution(p_days int default 30)
returns table (
  author_id            uuid,
  promises_kept_count  int,
  promises_kept_credit numeric,
  promises_total       int
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with _days as (
    select greatest(1, least(90, p_days)) as d
  ),
  paid_events as (
    -- payment events ใน p_days วันล่าสุด (dedup by contract+date)
    select distinct
      pl.contract_id,
      (pl.created_at at time zone 'Asia/Bangkok')::date as paid_date
    from public.payment_log pl
    cross join _days
    where pl.action = 'pay'
      and pl.created_at >= now() - (_days.d || ' days')::interval
  ),
  co_counts as (
    -- นับ distinct author per (contract_id, paid_date)
    select
      pe.contract_id,
      pe.paid_date,
      count(distinct f.author_id) as co_author_count
    from paid_events pe
    cross join _days
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.follow_up_result = 'promised'
      and f.next_follow_up_at is not null
      and f.created_at >= now() - (_days.d || ' days')::interval
      and (f.created_at at time zone 'Asia/Bangkok')::date
          between (pe.paid_date - interval '5 days')::date and pe.paid_date
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
    group by pe.contract_id, pe.paid_date
  ),
  window_contacts as (
    select
      pe.contract_id,
      pe.paid_date,
      f.id      as promise_id,
      f.author_id,
      1.0 / cc.co_author_count as credit_share
    from paid_events pe
    cross join _days
    join co_counts cc
      on cc.contract_id = pe.contract_id
      and cc.paid_date = pe.paid_date
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.follow_up_result = 'promised'
      and f.next_follow_up_at is not null
      and f.created_at >= now() - (_days.d || ' days')::interval
      and (f.created_at at time zone 'Asia/Bangkok')::date
          between (pe.paid_date - interval '5 days')::date and pe.paid_date
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
  ),
  promise_credits as (
    -- aggregate ที่ระดับ promise — 1 promise ได้ credit สูงสุด 1 ครั้ง
    select
      promise_id,
      author_id,
      max(credit_share) as credit_share
    from window_contacts
    group by promise_id, author_id
  ),
  credit_agg as (
    select
      author_id,
      count(*)::int                    as promises_kept_count,
      sum(credit_share)::numeric(10,2) as promises_kept_credit
    from promise_credits
    group by author_id
  ),
  promises_agg as (
    -- denominator: promises ทั้งหมดใน p_days วัน ที่มี next_follow_up_at
    select
      f.author_id,
      count(*)::int as promises_total
    from public.follow_ups f
    cross join _days
    join public.profiles pr on pr.id = f.author_id and pr.role = 'freelancer'
    where f.follow_up_result = 'promised'
      and f.next_follow_up_at is not null
      and f.created_at >= now() - (_days.d || ' days')::interval
    group by f.author_id
  )
  select
    coalesce(c.author_id, p.author_id)                        as author_id,
    coalesce(c.promises_kept_count, 0)                        as promises_kept_count,
    coalesce(c.promises_kept_credit, 0::numeric(10,2))        as promises_kept_credit,
    coalesce(p.promises_total, 0)                             as promises_total
  from credit_agg c
  full outer join promises_agg p on p.author_id = c.author_id;
$$;

grant execute on function public.get_promise_attribution(int) to authenticated, service_role;

-- ============================================================================
-- SECTION 3: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 3a) ตรวจ functions มีอยู่:
-- SELECT has_function_privilege('authenticated', 'public.get_freelancer_perf(integer)', 'EXECUTE');
--   expected: true
-- SELECT has_function_privilege('service_role', 'public.get_freelancer_perf(integer)', 'EXECUTE');
--   expected: true
-- SELECT has_function_privilege('authenticated', 'public.get_promise_attribution(integer)', 'EXECUTE');
--   expected: true
-- SELECT has_function_privilege('service_role', 'public.get_promise_attribution(integer)', 'EXECUTE');
--   expected: true

-- 3b) ตรวจ functions รันได้ (30 วัน default):
-- SELECT * FROM public.get_freelancer_perf() LIMIT 5;
-- SELECT * FROM public.get_promise_attribution() LIMIT 5;
--   expected: ≥0 rows (ไม่ error)

-- 3c) ตรวจ p_days parameter ทำงาน:
-- SELECT * FROM public.get_freelancer_perf(7) LIMIT 5;
-- SELECT * FROM public.get_promise_attribution(7) LIMIT 5;
--   expected: rows ≤ result จาก p_days=30 (window แคบกว่า)

-- 3d) ตรวจ views เดิมยังอยู่ครบ (additive — ห้ามหาย):
-- SELECT has_table_privilege('authenticated', 'public.v_freelancer_performance_30d', 'SELECT');
-- SELECT has_table_privilege('authenticated', 'public.v_promise_attribution_30d', 'SELECT');
--   expected: true ทั้งคู่
