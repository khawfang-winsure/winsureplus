-- 0098: เปิดสิทธิ์ role executive ให้ดูสกอร์การ์ดทีมโทร หน้า /staff-performance (read-only)
-- Pete เคาะ: exec เห็นทั้งหน้า /staff-performance แบบ read-only
--
-- ปัญหา: StaffPerformance.tsx เรียก 3 ทางที่ guard ไม่รวม exec ตอนนี้:
--   1) get_collector_scorecard   (0046) guard = is_admin() or is_staff()      → exec 0 rows
--   2) get_uncredited_collected  (0046) guard = is_admin() or is_staff()      → exec คืน 0
--   3) freelancer_grade_assignments RLS "fga_read" (0022) = is_admin() or is_staff()
--      or freelancer_id=auth.uid() → exec ไม่ใช่ทั้งสาม → 0 rows
--      (getCollectorScorecard() ใน db.ts query ตารางนี้ตรงผ่าน .from() ไม่ใช่ RPC
--       จึงโดน RLS ตรงๆ ไม่ผ่าน security definer)
--
-- ตัวอื่นที่หน้านี้เรียก "ไม่ต้องแตะ" (ตรวจแล้ว):
--   - get_collector_call_outcomes  → widen ไปแล้วใน 0097 (ข้าม)
--   - v_pj_recovery_summary/monthly/v_pj_days_late_dist/v_pj_recovery_outcome_monthly/summary (0066/0067)
--       → view ธรรมดา grant select ตรงถึง `authenticated` อยู่แล้ว (ไม่มี security_invoker/guard)
--       → exec (เป็น authenticated) เข้าถึงได้แล้วตั้งแต่แรก ไม่มีอะไรต้องแก้
--   - v_device_return_report (0073) → view ธรรมดา grant select ตรงถึง `authenticated` เช่นกัน
--       → getDeviceReturnByCollector() อ่านผ่านได้แล้ว (คอลัมน์ที่ select ไม่มี PII ลูกค้า)
--   - device_returns (ตาราง, ใช้ใน getDeviceReturnCountsByFreelancerThisMonth)
--       → มี policy device_returns_executive_read อยู่แล้ว (0026 §3f)
--   - profiles (ใช้ใน getCollectorScorecard Step 1)
--       → มี policy profiles_executive_read อยู่แล้ว (0026 §3g)
--   - app_settings (device_return_tiers) → read-open ทุก authenticated อยู่แล้ว (0018 §5i)
--
-- PII check: get_collector_scorecard/get_uncredited_collected คืนแค่ author_id/current_grade/
--   ตัวเลขผลงาน (ไม่มีชื่อ/เบอร์/บัตรลูกค้า) และ freelancer_grade_assignments มีแค่
--   freelancer_id/grade/assigned_at/assigned_by/ended_at (ไม่มี PII ลูกค้า) → ปลอดภัย widen ได้
--
-- Technique: create or replace function ก็อป body จาก 0046 เป๊ะทุกบรรทัด เปลี่ยนแค่ guard
--   (Postgres แก้ where guard ทีละบรรทัดไม่ได้ ต้อง recreate ทั้งก้อน — ตาม pattern 0097)
--   ส่วน RLS policy ใช้ drop+create ตาม pattern เดิมของโปรเจกต์ (0022/0026)
-- additive only: create or replace function + drop/create policy เท่านั้น ไม่แตะตาราง/ข้อมูลอื่น

-- ============================================================================
-- SECTION 1: get_collector_scorecard(p_start date, p_end date) — widen guard
-- body เหมือน 0046 เป๊ะ เปลี่ยนแค่บรรทัด outer where guard
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
  where public.is_admin() or public.is_staff() or public.is_executive();  -- guard: freelancer/anon → 0 rows; exec เห็นได้ (no PII)
$$;

grant execute on function public.get_collector_scorecard(date, date)
  to authenticated, service_role;

-- ============================================================================
-- SECTION 2: get_uncredited_collected(p_start date, p_end date) — widen guard
-- body เหมือน 0046 เป๊ะ เปลี่ยนแค่ case-when guard
-- ============================================================================

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
  select case when (public.is_admin() or public.is_staff() or public.is_executive()) then
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
-- SECTION 3: freelancer_grade_assignments RLS — widen fga_read เพิ่ม is_executive()
-- getCollectorScorecard() (db.ts) query ตารางนี้ตรงผ่าน .from() (ไม่ใช่ RPC) → โดน RLS ตรงๆ
-- body เดิมจาก 0022 เป๊ะ เพิ่มแค่ OR is_executive()
-- ============================================================================

drop policy if exists fga_read on public.freelancer_grade_assignments;

create policy fga_read on public.freelancer_grade_assignments
  for select to authenticated
  using (
    is_admin()
    OR is_staff()
    OR is_executive()
    OR freelancer_id = auth.uid()
  );

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 1) ตรวจ grant (เหมือนเดิม ไม่เปลี่ยน):
-- SELECT has_function_privilege('authenticated', 'public.get_collector_scorecard(date,date)', 'EXECUTE');  -- true
-- SELECT has_function_privilege('authenticated', 'public.get_uncredited_collected(date,date)', 'EXECUTE'); -- true
-- SELECT has_table_privilege('authenticated', 'public.freelancer_grade_assignments', 'SELECT');             -- true

-- 2) รันได้ไม่ error (1 เดือนจริง) — เทียบ reconcile invariant ต้องยังผ่านเหมือน 0046:
-- WITH s AS (SELECT coalesce(sum(collected_baht),0) c FROM public.get_collector_scorecard('2026-06-01','2026-06-30')),
--      u AS (SELECT public.get_uncredited_collected('2026-06-01','2026-06-30') u),
--      t AS (SELECT coalesce(sum(amount),0) t FROM public.payment_log
--              WHERE action='pay' AND (created_at at time zone 'Asia/Bangkok')::date between '2026-06-01' and '2026-06-30')
-- SELECT s.c AS collected_sum, u.u AS uncredited, t.t AS total_pay, (s.c + u.u - t.t) AS diff_should_be_zero
-- FROM s, u, t;  -- diff = 0

-- 3) freelancer เรียกแล้วเห็น 0 rows / 0 (guard ยังกันอยู่) — ทดสอบด้วย token freelancer ผ่าน REST

-- 4) NEW: executive เรียกแล้วเห็น rows จริง (ไม่ใช่ 0) — ทดสอบด้วย token executive ผ่าน REST
--    - SELECT * FROM public.get_collector_scorecard('2026-06-01','2026-06-30');  -- rows > 0 (ถ้ามี activity)
--    - SELECT public.get_uncredited_collected('2026-06-01','2026-06-30');        -- ไม่ error
--    - SELECT * FROM public.freelancer_grade_assignments;                        -- rows (ไม่ว่างถ้ามี assignment)

-- 5) ตรวจ policy count บน freelancer_grade_assignments (ต้องเห็น fga_read + fga_admin_write):
-- SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname='public' AND tablename='freelancer_grade_assignments';
