-- 0097: เปิดสิทธิ์ role executive ให้ดู get_collector_call_outcomes (widget ผลการโทรทีม หน้า /exec)
-- ปัญหา: 0068 guard = is_admin() or is_staff() เท่านั้น → exec เรียกได้ 0 rows เสมอ (widget โชว์ 0)
-- แก้: recreate function ทั้งก้อน (Postgres แก้ where guard ทีละบรรทัดไม่ได้) body เหมือน 0068 เป๊ะ
--      เปลี่ยนแค่บรรทัด outer where guard: เพิ่ม `or public.is_executive()`
-- is_executive() นิยามที่ 0026_executive_role.sql (line 31-44) — role='executive' AND active=true
-- ปลอดภัย: RPC นี้ไม่มี PII ลูกค้า (แค่ author_id/author_name ของพนักงานผู้โทร + ตัวเลขสรุป)
--          function เป็น security definer อยู่แล้ว → inner query (follow_ups/payment_log) ไม่ผ่าน RLS
--          ของผู้เรียกอยู่แล้ว มีแค่ outer guard เป็นด่านเดียวที่ต้องเปิด
-- additive only: create or replace function เท่านั้น ไม่แตะตาราง/view อื่น

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
  where public.is_admin() or public.is_staff() or public.is_executive();   -- guard: freelancer/anon → 0 rows; exec เห็นได้ (no PII)
$$;

grant execute on function public.get_collector_call_outcomes(date, date)
  to authenticated, service_role;

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 1) ตรวจ grant (เหมือนเดิม ไม่เปลี่ยน):
-- SELECT has_function_privilege('authenticated', 'public.get_collector_call_outcomes(date,date)', 'EXECUTE'); -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_call_outcomes(date,date)', 'EXECUTE'); -- true

-- 2) รันได้ไม่ error (1 เดือนจริง):
-- SELECT * FROM public.get_collector_call_outcomes('2026-06-01','2026-06-30');

-- 3) INVARIANT (kept+broken+pending = made ต่อทุก row) — ยังต้องผ่านเหมือนเดิม:
-- SELECT author_id, promises_made, promises_kept + promises_broken + promises_pending AS sum_parts
--   FROM public.get_collector_call_outcomes('2026-06-01','2026-06-30')
--  WHERE promises_made <> promises_kept + promises_broken + promises_pending;  -- 0 rows

-- 4) freelancer เรียกแล้วเห็น 0 rows (guard ยังกันอยู่) — ทดสอบด้วย token freelancer ผ่าน REST

-- 5) NEW: executive เรียกแล้วเห็น rows จริง (ไม่ใช่ 0) — ทดสอบด้วย token executive ผ่าน REST
--    หรือ: SET LOCAL role ... / เทียบ is_executive() = true สำหรับ user นั้น
