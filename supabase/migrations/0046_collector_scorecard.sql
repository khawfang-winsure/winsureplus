-- 0046: Collector Scorecard — last-touch attribution ของยอดเก็บ (action='pay') ให้ freelancer ที่โทร
-- ตามช่วงวัน arbitrary [p_start, p_end]. additive only: create or replace function เท่านั้น
-- ไม่ drop/alter ของเดิม (get_freelancer_perf / get_promise_attribution / views คงไว้ — WeeklyReport ยังเรียกอยู่)
--
-- Decisions locked by Pete (2026-06-17) + ครีม:
--   Attribution = INFER, LAST-TOUCH — สาย contact_method='phone' ที่ใกล้ก่อนการจ่ายที่สุด
--     ได้เครดิตยอดเต็มก้อนนั้น (ไม่หาร), strictly before + ภายใน 7 วันก่อนวันจ่ายจริง (ระดับ timestamp)
--   Tie-break = follow_ups.id desc → deterministic 1 ผู้ชนะ
--   Scope = FREELANCER ONLY (role='freelancer' AND active=true) — staff ไม่นับทั้ง numerator + count
--   Window = 7 วัน
--   Per-grade = คืน current_grade (1 row ต่อ author_id × current_grade) → db.ts aggregate เป็น byGrade[]
--               (ตาม pattern get_freelancer_perf 0028 เป๊ะ — UI drill-down per-grade ในช่วงเดียวกัน)
--
-- SECURITY DEFINER: last-touch ต้อง self-join follow_ups + payment_log ข้าม RLS.
--   เพราะ sql function raise exception ไม่ได้ → guard ด้วย (is_admin() or is_staff()) ที่ outer where
--   freelancer/anon เรียก → คืน 0 rows (ไม่หลุดข้อมูลคนอื่น). View นี้ใช้บนหน้า admin/staff เท่านั้น
--
-- RECONCILE SPINE (สำคัญ): qualifying-call predicate ต้อง byte-identical ระหว่าง 2 ฟังก์ชัน
--   get_collector_scorecard (EXISTS → credited) กับ get_uncredited_collected (NOT EXISTS → uncredited)
--   → Σ collected ต่อคน + uncredited = Σ payment_log.amount (action='pay') ในช่วง

-- ============================================================================
-- SECTION 1: get_collector_scorecard(p_start date, p_end date)
-- ============================================================================

create or replace function public.get_collector_scorecard(
  p_start date,
  p_end   date
)
returns table (
  author_id           uuid,
  current_grade       text,      -- ครีม: per-grade drill-down (null = สัญญาไม่มีเกรด — คงไว้ กัน total เพี้ยน)
  calls               int,       -- (b) จำนวนสายโทร contact_method='phone' ในช่วง
  unique_contracts    int,       -- (c) distinct CONTRACT (ทุก contact_method) — label UI "สัญญาที่ดูแล"
  total_attempts      int,       -- ทุก follow_up ในช่วง (denominator contact-rate)
  successful_attempts int,       -- result ∈ (contacted,promised,paid,returned,other)
  collected_baht      numeric,   -- (a) last-touch attribution — SUM(amount) ก้อนที่ชนะ
  last_activity_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- (a) ยอดเก็บ last-touch: แต่ละ payment_log 'pay' ในช่วง → หาสาย freelancer ที่นำก่อน 1 สาย
  paid_events as (
    select
      pl.id          as payment_id,
      pl.contract_id,
      pl.amount,
      pl.created_at  as paid_ts
    from public.payment_log pl
    where pl.action = 'pay'
      and (pl.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  last_touch as (
    -- DISTINCT ON (payment_id): ผู้ชนะคือสายที่ created_at มากสุด (ใกล้ paid_ts สุด)
    -- tie-break เวลาเป๊ะกัน → f.id desc → deterministic
    select distinct on (pe.payment_id)
      pe.payment_id,
      pe.amount,
      pe.contract_id,
      f.author_id    as winner_author_id
    from paid_events pe
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.contact_method = 'phone'
      and f.created_at < pe.paid_ts                              -- strictly before
      and f.created_at >= pe.paid_ts - interval '7 days'         -- ภายใน 7 วัน (ระดับ timestamp)
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    order by pe.payment_id, f.created_at desc, f.id desc
  ),
  collected as (
    -- group ยอดที่ชนะตาม (winner, current_grade ของสัญญานั้น) — mirror per-grade ของ fu_metrics
    select
      lt.winner_author_id as author_id,
      c.current_grade,
      sum(lt.amount)      as collected_baht
    from last_touch lt
    join public.contracts c on c.id = lt.contract_id
    group by lt.winner_author_id, c.current_grade
  ),
  -- (b)(c) + attempts: 1 scan ของ follow_ups ในช่วง ของ freelancer active, group by author + grade
  fu_metrics as (
    select
      f.author_id,
      c.current_grade,
      count(*) filter (where f.contact_method = 'phone')::int                          as calls,
      count(distinct f.contract_id)::int                                               as unique_contracts,
      count(*)::int                                                                    as total_attempts,
      count(*) filter (
        where f.follow_up_result in ('contacted','promised','paid','returned','other')
      )::int                                                                           as successful_attempts,
      max(f.created_at)                                                                as last_activity_at
    from public.follow_ups f
    join public.contracts c on c.id = f.contract_id
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
    group by f.author_id, c.current_grade
  )
  select
    coalesce(m.author_id, col.author_id)        as author_id,
    coalesce(m.current_grade, col.current_grade) as current_grade,
    coalesce(m.calls, 0)                         as calls,
    coalesce(m.unique_contracts, 0)              as unique_contracts,
    coalesce(m.total_attempts, 0)                as total_attempts,
    coalesce(m.successful_attempts, 0)           as successful_attempts,
    coalesce(col.collected_baht, 0)::numeric     as collected_baht,
    m.last_activity_at                           as last_activity_at
  from fu_metrics m
  full outer join collected col
    on col.author_id = m.author_id
    and col.current_grade is not distinct from m.current_grade   -- null-safe join (สัญญาไม่มีเกรด)
  where public.is_admin() or public.is_staff();                  -- guard: freelancer/anon → 0 rows
$$;

grant execute on function public.get_collector_scorecard(date, date)
  to authenticated, service_role;

-- ============================================================================
-- SECTION 2: get_uncredited_collected(p_start date, p_end date)
-- ============================================================================
-- ยอด 'pay' ในช่วงที่ "ไม่มี" qualifying phone call ของ freelancer active ใน 7 วันก่อน
-- → ไม่ถูก credit ใคร. ให้ UI โชว์ "ยอดที่ไม่มีสายนำ" เพื่อ reconcile
--   Σ collected ต่อคน + uncredited = Σ payment_log.amount (action='pay') ในช่วง
--
-- predicate ใน NOT EXISTS ต้อง byte-identical กับ join condition ใน last_touch (Section 1)
-- guard เดียวกัน (is_admin or is_staff) — sql function คืน scalar ใช้ case ห่อ

create or replace function public.get_uncredited_collected(
  p_start date,
  p_end   date
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case when (public.is_admin() or public.is_staff()) then
    coalesce((
      select sum(pl.amount)
      from public.payment_log pl
      where pl.action = 'pay'
        and (pl.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
        and not exists (
          select 1
          from public.follow_ups f
          join public.profiles pr
            on pr.id = f.author_id
            and pr.role = 'freelancer'
            and pr.active = true
          where f.contract_id = pl.contract_id
            and f.contact_method = 'phone'
            and f.created_at < pl.created_at                       -- strictly before
            and f.created_at >= pl.created_at - interval '7 days'  -- ภายใน 7 วัน
        )
    ), 0)
  else 0::numeric end;
$$;

grant execute on function public.get_uncredited_collected(date, date)
  to authenticated, service_role;

-- ============================================================================
-- SECTION 3: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 3a) ตรวจ functions + grant:
-- SELECT has_function_privilege('authenticated', 'public.get_collector_scorecard(date,date)', 'EXECUTE');  -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_scorecard(date,date)', 'EXECUTE');  -- true
-- SELECT has_function_privilege('authenticated', 'public.get_uncredited_collected(date,date)', 'EXECUTE'); -- true

-- 3b) รันได้ไม่ error:
-- SELECT * FROM public.get_collector_scorecard('2026-05-01','2026-05-31');
-- SELECT public.get_uncredited_collected('2026-05-01','2026-05-31');

-- 3c) RECONCILE (ตรวจเงินไม่หาย — รัน 1 เดือนจริง):
-- WITH s AS (SELECT coalesce(sum(collected_baht),0) c FROM public.get_collector_scorecard('2026-05-01','2026-05-31')),
--      u AS (SELECT public.get_uncredited_collected('2026-05-01','2026-05-31') u),
--      t AS (SELECT coalesce(sum(amount),0) t FROM public.payment_log
--              WHERE action='pay' AND (created_at at time zone 'Asia/Bangkok')::date between '2026-05-01' and '2026-05-31')
-- SELECT s.c AS collected_sum, u.u AS uncredited, t.t AS total_pay, (s.c + u.u - t.t) AS diff_should_be_zero
-- FROM s, u, t;  -- diff = 0

-- 3d) freelancer เรียกแล้วเห็น 0 rows (guard ทำงาน) — ทดสอบด้วย token freelancer ผ่าน REST
