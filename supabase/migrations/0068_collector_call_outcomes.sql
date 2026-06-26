-- 0068: get_collector_call_outcomes — รายงาน "ผลการโทร + ผลการนัดชำระ" ต่อคนติดตามหนี้ ตามช่วงวัน
-- ใช้กับหน้า /staff-performance — รองรับทั้งภาพรวมทีม (รวมทุกคน) + รายคน (1 row ต่อ author)
-- additive only: create or replace function เท่านั้น (ไม่แตะ get_collector_scorecard / views เดิม)
--
-- mirror pattern ของ get_collector_scorecard (0046):
--   - scope = FREELANCER ONLY (role='freelancer' AND active=true) — staff/admin author ไม่นับ
--   - SECURITY DEFINER + guard (is_admin() or is_staff()) ที่ outer where → freelancer/anon คืน 0 rows
--   - timezone = 'Asia/Bangkok' ทุกที่ที่ cast timestamptz → date (กัน off-by-one; session tz = UTC)
--   - grant execute → authenticated, service_role
--
-- นิยามแต่ละ metric (1 row ต่อ author_id):
--   cases_followed   = จำนวนสัญญา (distinct) ที่คนนี้บันทึก follow-up อย่างน้อย 1 ครั้งในช่วง
--   cases_reached    = จำนวนสัญญา (distinct) ที่ "ติดต่อลูกค้าได้จริง" อย่างน้อย 1 ครั้ง
--                      (result ∈ contacted/promised/paid/refused/returned)
--   cases_no_answer  = จำนวนสัญญา (distinct) ที่มี result='no_answer' อย่างน้อย 1 ครั้ง
--   cases_unreachable= จำนวนสัญญา (distinct) ที่ "ติดต่อไม่ได้เลย" — มี no_answer แต่ไม่เคยติดต่อได้เลย
--   promises_made    = จำนวน "ครั้ง" ที่นัดชำระ (row result='promised' AND next_follow_up_at not null) ในช่วง
--   promises_kept    = ในจำนวนนัดข้างต้น — นับครั้งที่ลูกค้า "จ่ายตามนัด":
--                      มี payment_log action='pay' ของสัญญานั้น ที่วันจ่าย (Bangkok) อยู่ระหว่าง
--                      วันที่นัด (created_at ของ follow-up) ถึง วันที่นัดจะจ่าย (next_follow_up_at) — รวมปลายทั้งสอง
--   promises_broken  = นัดที่ "ไม่ kept" AND วันนัด < วันนี้ (Bangkok) → ผิดนัด (เลยวันนัดแล้วยังไม่จ่าย)
--   promises_pending = นัดที่ "ไม่ kept" AND วันนัด >= วันนี้ (Bangkok) → ยังไม่ถึงวันนัด (แยกออกจาก broken)
--   => promises_kept + promises_broken + promises_pending = promises_made (mutually exclusive, exhaustive)
--
-- payment_log: action='pay' = การจ่ายจริง; วันจ่าย = created_at (payment_log ไม่มี paid_at);
--              จำนวนเงิน = amount (ไม่เกี่ยวกับ report นี้ — นับเฉพาะ "มีการจ่ายในกรอบเวลานัด" หรือไม่)

create or replace function public.get_collector_call_outcomes(
  p_start date,
  p_end   date
)
returns table (
  author_id        uuid,
  author_name      text,
  cases_followed   int,
  cases_reached    int,
  cases_no_answer  int,
  cases_unreachable int,
  promises_made    int,
  promises_kept    int,
  promises_broken  int,
  promises_pending int
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- follow_ups ของ freelancer active ในช่วง (Bangkok date) — 1 scan ใช้ทั้ง case-counts + promise events
  fu as (
    select
      f.id,
      f.author_id,
      f.author_name,
      f.contract_id,
      f.follow_up_result,
      f.created_at,
      f.next_follow_up_at
    from public.follow_ups f
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  -- case-counts: ต่อ (author, contract) มีผลแบบ reached / no_answer ไหม
  case_rollup as (
    select
      author_id,
      contract_id,
      bool_or(follow_up_result in ('contacted','promised','paid','refused','returned')) as ever_reached,
      bool_or(follow_up_result = 'no_answer')                                            as ever_no_answer
    from fu
    group by author_id, contract_id
  ),
  case_metrics as (
    select
      author_id,
      count(*)::int                                                          as cases_followed,
      count(*) filter (where ever_reached)::int                              as cases_reached,
      count(*) filter (where ever_no_answer)::int                            as cases_no_answer,
      count(*) filter (where ever_no_answer and not ever_reached)::int       as cases_unreachable
    from case_rollup
    group by author_id
  ),
  -- promise events: 1 row ต่อ "ครั้งที่นัด" — จัดประเภท kept / broken / pending แบบ mutually exclusive
  promise_events as (
    select
      fu.author_id,
      fu.contract_id,
      (fu.created_at        at time zone 'Asia/Bangkok')::date as promised_on_date,    -- วันที่บันทึกนัด
      (fu.next_follow_up_at at time zone 'Asia/Bangkok')::date as promise_due_date,    -- วันที่นัดจะจ่าย
      exists (
        select 1
        from public.payment_log pl
        where pl.contract_id = fu.contract_id
          and pl.action = 'pay'
          and (pl.created_at at time zone 'Asia/Bangkok')::date
                between (fu.created_at        at time zone 'Asia/Bangkok')::date
                    and (fu.next_follow_up_at at time zone 'Asia/Bangkok')::date
      ) as kept
    from fu
    where fu.follow_up_result = 'promised'
      and fu.next_follow_up_at is not null
  ),
  promise_metrics as (
    select
      author_id,
      count(*)::int                                                                          as promises_made,
      count(*) filter (where kept)::int                                                      as promises_kept,
      count(*) filter (where not kept and promise_due_date <  (now() at time zone 'Asia/Bangkok')::date)::int as promises_broken,
      count(*) filter (where not kept and promise_due_date >= (now() at time zone 'Asia/Bangkok')::date)::int as promises_pending
    from promise_events
    group by author_id
  ),
  -- ชื่อ author (max ต่อ author) จาก follow_ups ในช่วง
  names as (
    select author_id, max(author_name) as author_name
    from fu
    group by author_id
  )
  select
    coalesce(cm.author_id, pm.author_id)        as author_id,
    n.author_name                               as author_name,
    coalesce(cm.cases_followed, 0)              as cases_followed,
    coalesce(cm.cases_reached, 0)               as cases_reached,
    coalesce(cm.cases_no_answer, 0)             as cases_no_answer,
    coalesce(cm.cases_unreachable, 0)           as cases_unreachable,
    coalesce(pm.promises_made, 0)               as promises_made,
    coalesce(pm.promises_kept, 0)               as promises_kept,
    coalesce(pm.promises_broken, 0)             as promises_broken,
    coalesce(pm.promises_pending, 0)            as promises_pending
  from case_metrics cm
  full outer join promise_metrics pm on pm.author_id = cm.author_id
  left join names n on n.author_id = coalesce(cm.author_id, pm.author_id)
  where public.is_admin() or public.is_staff();   -- guard: freelancer/anon → 0 rows
$$;

grant execute on function public.get_collector_call_outcomes(date, date)
  to authenticated, service_role;

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 1) ตรวจ grant:
-- SELECT has_function_privilege('authenticated', 'public.get_collector_call_outcomes(date,date)', 'EXECUTE'); -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_call_outcomes(date,date)', 'EXECUTE'); -- true

-- 2) รันได้ไม่ error (1 เดือนจริง):
-- SELECT * FROM public.get_collector_call_outcomes('2026-06-01','2026-06-30');

-- 3) INVARIANT (kept+broken+pending = made ต่อทุก row):
-- SELECT author_id, promises_made, promises_kept + promises_broken + promises_pending AS sum_parts
--   FROM public.get_collector_call_outcomes('2026-06-01','2026-06-30')
--  WHERE promises_made <> promises_kept + promises_broken + promises_pending;  -- 0 rows

-- 4) freelancer เรียกแล้วเห็น 0 rows (guard ทำงาน) — ทดสอบด้วย token freelancer ผ่าน REST
