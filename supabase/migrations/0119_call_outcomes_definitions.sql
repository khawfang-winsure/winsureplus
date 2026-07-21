-- 0119: แก้นิยาม "ตามนัด" + รวมนิยาม "โทรติด" ให้เป็นอันเดียวทั้งระบบ (Pete ล็อกแล้ว 21 ก.ค. 2026)
-- recreate get_collector_call_outcomes (0097) + get_collector_scorecard (0098) ทั้งฟังก์ชัน
-- (Postgres แก้ WHERE/เงื่อนไขทีละบรรทัดไม่ได้ ต้อง recreate ทั้งก้อน — ตาม pattern 0097/0098)
-- คงรายชื่อ + ลำดับคอลัมน์ที่คืนออกมาเดิมทุกตัว (UI เดิมใช้อยู่) — เปลี่ยนแค่นิยามข้างในตามด้านล่าง
--
-- ============================================================================
-- ก) "ตามนัด" (promises kept/broken/pending) — get_collector_call_outcomes เท่านั้น
-- ============================================================================
-- เดิม: มี payment_log action='pay' แถวไหนก็ได้ ระหว่าง (วันที่บันทึกนัด .. วันนัด) = kept (ไม่ดูยอด ไม่มี grace)
-- ใหม่: จ่ายรวมได้ >= 80% ของ follow_ups.promised_amount ภายใน (วันที่บันทึกนัด .. วันนัด + 3 วัน grace)
--   - grace 3 วัน นับหลังวันนัด (promise_due_date + 3 = promise_grace_date)
--   - promised_amount เป็น null หรือ 0 (2/42 เคสที่ไม่ได้บันทึกยอด) → fallback: มีเงินเข้าเท่าไหร่ก็ได้
--     ในช่วงเดียวกัน = kept
--   - pending = ยังไม่ถึง วันนัด+3 และยังไม่ถึงเกณฑ์ · broken = เลย วันนัด+3 แล้วยังไม่ถึงเกณฑ์
--   - invariant คงเดิม: kept + broken + pending = made (ทุก author_id) — smoke query ท้ายไฟล์
--
-- ============================================================================
-- ข) "โทรติด" (contact-rate) — รวมเป็นนิยามเดียวทั้งระบบ ใช้ทั้ง 2 ฟังก์ชัน
-- ============================================================================
-- ก่อนหน้านี้มี 2 นิยามขัดกัน:
--   - get_collector_call_outcomes (case_rollup.ever_reached): follow_up_result in
--       ('contacted','promised','paid','refused','returned')  -- นับรายเคส (case-level)
--   - get_collector_scorecard (fu_metrics.successful_attempts): follow_up_result in
--       ('contacted','promised','paid','returned','other')    -- นับรายสาย (call-level) — มี 'other' ไม่มี 'refused'
-- นิยามเดียวทั้งระบบ (ตัวตั้ง = คุยกับคนได้จริง):
--   follow_up_result in ('contacted','promised','paid','refused','returned')
--   'no_answer' / 'other' / 'line_pending' ไม่นับว่าติด
--   ตัวหาร = ทุกแถว follow_ups ของคนนั้นในช่วงเวลา (นับรายสาย ไม่ใช่รายเคส)
-- ผลกระทบจริง:
--   - get_collector_call_outcomes: case_rollup.ever_reached ใช้ list นี้อยู่แล้ว (ไม่มีการเปลี่ยนแปลงเชิงผล
--     ลัพธ์ตรงจุดนี้) — recreate เพื่อยืนยัน/ล็อกนิยามให้ตรงกับ scorecard ชัดเจน + เพราะไฟล์นี้ recreate
--     ทั้งฟังก์ชันอยู่แล้วจากการแก้ ก) ด้านบน
--   - get_collector_scorecard: fu_metrics.successful_attempts เปลี่ยนจาก
--       ('contacted','promised','paid','returned','other') → ('contacted','promised','paid','refused','returned')
--     (ตัด 'other' ออก เพิ่ม 'refused' เข้า) — นี่คือจุดที่ต่างจากเดิมจริง
--
-- additive only: create or replace function เท่านั้น ไม่แตะตาราง/view/ข้อมูลอื่น
-- signature เดิมเป๊ะทั้งคู่ (date, date) — ไม่ต้อง drop
-- ============================================================================


-- ============================================================================
-- SECTION 1: get_collector_call_outcomes(p_start date, p_end date)
-- ============================================================================
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
      f.next_follow_up_at,
      f.promised_amount
    from public.follow_ups f
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  -- case-counts: ต่อ (author, contract) มีผลแบบ reached / no_answer ไหม
  -- (0119) ever_reached ใช้ list เดียวกับนิยาม "โทรติด" รวมของระบบ — เดิมตรงอยู่แล้ว ไม่เปลี่ยนผลลัพธ์
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
  -- (0119) promise_window: คำนวณยอดจ่ายจริงในหน้าต่าง (วันบันทึกนัด .. วันนัด+3 grace) ครั้งเดียว
  -- ต่อ promise event กัน correlated subquery ซ้ำ 2 รอบ
  promise_window as (
    select
      fu.id                                                                as follow_up_id,
      fu.author_id,
      fu.contract_id,
      (fu.next_follow_up_at at time zone 'Asia/Bangkok')::date + 3         as promise_grace_date,  -- วันนัด + 3 (grace)
      coalesce(fu.promised_amount, 0)                                      as promised_amount,
      coalesce((
        select sum(pl.amount)
        from public.payment_log pl
        where pl.contract_id = fu.contract_id
          and pl.action = 'pay'
          and (pl.created_at at time zone 'Asia/Bangkok')::date
                between (fu.created_at        at time zone 'Asia/Bangkok')::date
                    and (fu.next_follow_up_at at time zone 'Asia/Bangkok')::date + 3
      ), 0)                                                                 as paid_in_window
    from fu
    where fu.follow_up_result = 'promised'
      and fu.next_follow_up_at is not null
  ),
  -- promise events: 1 row ต่อ "ครั้งที่นัด" — จัดประเภท kept / broken / pending แบบ mutually exclusive
  -- (0119) kept: promised_amount>0 → จ่ายรวม >= 80% ของยอดนัด ภายใน grace window
  --              promised_amount=0/null → fallback มีเงินเข้าเท่าไหร่ก็ได้ในช่วงเดียวกัน
  promise_events as (
    select
      pw.author_id,
      pw.contract_id,
      pw.promise_grace_date,
      case
        when pw.promised_amount > 0 then pw.paid_in_window >= pw.promised_amount * 0.8
        else pw.paid_in_window > 0
      end as kept
    from promise_window pw
  ),
  promise_metrics as (
    select
      author_id,
      count(*)::int                                                                                             as promises_made,
      count(*) filter (where kept)::int                                                                         as promises_kept,
      count(*) filter (where not kept and promise_grace_date <  (now() at time zone 'Asia/Bangkok')::date)::int as promises_broken,
      count(*) filter (where not kept and promise_grace_date >= (now() at time zone 'Asia/Bangkok')::date)::int as promises_pending
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
  where public.is_admin() or public.is_staff() or public.is_executive();   -- guard: freelancer/anon → 0 rows; exec เห็นได้ (no PII)
$$;

grant execute on function public.get_collector_call_outcomes(date, date)
  to authenticated, service_role;

comment on function public.get_collector_call_outcomes(date, date) is
  '(0119) ตามนัด = จ่ายรวม>=80% ของ promised_amount ภายในวันนัด+3วัน grace (ไม่มียอด/0 → มีเงินเข้าก็นับ); โทรติด (cases_reached) ใช้ list เดียวกับ get_collector_scorecard: contacted/promised/paid/refused/returned';

-- ============================================================================
-- SECTION 2: get_collector_scorecard(p_start date, p_end date)
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
  successful_attempts int,       -- (0119) result ∈ (contacted,promised,paid,refused,returned) — เดิม (...,returned,other)
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
      -- (0119) รวมนิยาม "โทรติด" กับ get_collector_call_outcomes: ตัด 'other' ออก เพิ่ม 'refused' เข้า
      count(*) filter (
        where f.follow_up_result in ('contacted','promised','paid','refused','returned')
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

comment on function public.get_collector_scorecard(date, date) is
  '(0119) successful_attempts (โทรติด) รวมนิยามกับ get_collector_call_outcomes: contacted/promised/paid/refused/returned (ตัด other ออก เพิ่ม refused เข้า)';

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 1) ตรวจ grant (เหมือนเดิม ไม่เปลี่ยน):
-- SELECT has_function_privilege('authenticated', 'public.get_collector_call_outcomes(date,date)', 'EXECUTE'); -- true
-- SELECT has_function_privilege('authenticated', 'public.get_collector_scorecard(date,date)', 'EXECUTE');     -- true

-- 2) รันได้ไม่ error (1 เดือนจริง):
-- SELECT * FROM public.get_collector_call_outcomes('2026-06-01','2026-06-30');
-- SELECT * FROM public.get_collector_scorecard('2026-06-01','2026-06-30');

-- 3) INVARIANT (kept+broken+pending = made ต่อทุก row) — ต้องผ่านเหมือนเดิม (0097 มีอันนี้อยู่แล้ว):
-- SELECT author_id, promises_made, promises_kept + promises_broken + promises_pending AS sum_parts
--   FROM public.get_collector_call_outcomes('2026-06-01','2026-06-30')
--  WHERE promises_made <> promises_kept + promises_broken + promises_pending;  -- 0 rows

-- 4) NEW: ตัวอย่างเคสที่นิยามใหม่เปลี่ยนผล — นัดจ่าย 5,000 จ่ายจริงแค่ 2,000 (40%) ภายในวันนัด+2 วัน
--    เดิม kept (มี payment_log ใดๆ ในช่วง) ใหม่ broken (ไม่ถึง 80% แม้ยังอยู่ใน grace ก็ยัง pending ไม่ kept)
--    หา author_id ที่ promises_kept เปลี่ยนจากก่อน 0119 (เทียบ manual กับข้อมูลจริงก่อน apply)

-- 5) NEW: โทรติด (successful_attempts) ต้องไม่รวม follow_up_result='other' อีกต่อไป:
-- SELECT sum(successful_attempts) AS sa_new
--   FROM public.get_collector_scorecard('2026-06-01','2026-06-30');
-- -- เทียบด้วยมือ: ต้อง <= ผลรวมแบบเดิม (list เดิมมี 'other' ซึ่งปกติมีจำนวนมากกว่า 'refused')

-- 6) freelancer เรียกแล้วเห็น 0 rows (guard ยังกันอยู่) — ทดสอบด้วย token freelancer ผ่าน REST
