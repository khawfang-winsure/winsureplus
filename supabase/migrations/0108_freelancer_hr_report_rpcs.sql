-- 0108: RPC รายงาน HR สรุปงานทีมฟรีแลนซ์ (หน้ารายงานผู้บริหาร/หัวหน้า)
-- 2 RPC (read-only, aggregate ฝั่ง DB → ไม่ติด PAGE_CAP):
--   B1 get_freelancer_hr_by_day(p_start, p_end)      — 1 แถวต่อ (author × วัน) frontend roll up รายคนเอง
--   B2 get_freelancer_hr_daily_log(p_author, ...)    — drill-down รายเคส (join contracts เอาชื่อ/เลขสัญญา)
--
-- guard: is_admin() / is_staff() / is_executive() แยกขาด 3 ตัว (exec ไม่ผ่าน is_staff/is_admin)
--        ทุก RPC guard `public.is_admin() OR public.is_staff() OR public.is_executive()`
--        → freelancer/anon เรียกได้ 0 rows (mirror pattern 0068/0097/0098)
-- SECURITY DEFINER + set search_path = public, pg_catalog (inner query ไม่ผ่าน RLS ผู้เรียก
--        → outer guard เป็นด่านเดียว)
-- Scope ข้อมูล: profiles.role='freelancer' AND active=true (mirror 0068/0098)
-- Timezone: Asia/Bangkok ทุก metric (bucket ชั่วโมง + date + time)
-- reuse: promises-kept/collected ให้ frontend เรียก get_collector_call_outcomes (0097) +
--        get_collector_scorecard (0098) เอง — ไม่ทำซ้ำที่นี่
-- additive only: create or replace function + grant เท่านั้น

-- ============================================================================
-- SECTION 1 (B1): get_freelancer_hr_by_day — สรุป 1 แถวต่อ (author × วันกรุงเทพ)
--   bucket ชั่วโมงกรุงเทพ: เช้า 8–11, บ่าย 12–16, เย็น 17–20 (นอกช่วงไม่เข้า bucket แต่ยังใน logs_total)
--   reached: result ∈ (contacted,promised,paid,refused,returned)
--   attempts: result is distinct from 'line_pending' (null-safe: null=นับเป็น attempt)
--   demands: counts_as_demand (การทวงลูกหนี้ครั้งแรกของวัน — 0107)
--   promises_made: result='promised' AND next_follow_up_at is not null
-- ============================================================================

create or replace function public.get_freelancer_hr_by_day(
  p_start date,
  p_end   date
)
returns table (
  author_id       uuid,
  author_name     text,
  day             date,
  logs_total      bigint,
  cases_touched   bigint,
  first_activity  time,
  last_activity   time,
  morning_count   bigint,
  afternoon_count bigint,
  evening_count   bigint,
  reached_count   bigint,
  attempts_count  bigint,
  debtor_count    bigint,
  other_count     bigint,
  demands_count   bigint,
  promises_made   bigint
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    f.author_id,
    pr.full_name                                                as author_name,
    (f.created_at at time zone 'Asia/Bangkok')::date            as day,
    count(*)                                                    as logs_total,
    count(distinct f.contract_id)                               as cases_touched,
    min((f.created_at at time zone 'Asia/Bangkok')::time)       as first_activity,
    max((f.created_at at time zone 'Asia/Bangkok')::time)       as last_activity,
    count(*) filter (
      where extract(hour from (f.created_at at time zone 'Asia/Bangkok')) between 8 and 11
    )                                                           as morning_count,
    count(*) filter (
      where extract(hour from (f.created_at at time zone 'Asia/Bangkok')) between 12 and 16
    )                                                           as afternoon_count,
    count(*) filter (
      where extract(hour from (f.created_at at time zone 'Asia/Bangkok')) between 17 and 20
    )                                                           as evening_count,
    count(*) filter (
      where f.follow_up_result in ('contacted','promised','paid','refused','returned')
    )                                                           as reached_count,
    count(*) filter (
      where f.follow_up_result is distinct from 'line_pending'
    )                                                           as attempts_count,
    count(*) filter (where f.contact_target = 'debtor')         as debtor_count,
    count(*) filter (where f.contact_target = 'other')          as other_count,
    count(*) filter (where f.counts_as_demand)                  as demands_count,
    count(*) filter (
      where f.follow_up_result = 'promised' and f.next_follow_up_at is not null
    )                                                           as promises_made
  from public.follow_ups f
  join public.profiles pr
    on pr.id = f.author_id
    and pr.role = 'freelancer'
    and pr.active = true
  where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
    and (public.is_admin() or public.is_staff() or public.is_executive())
  group by f.author_id, pr.full_name, (f.created_at at time zone 'Asia/Bangkok')::date;
$$;

grant execute on function public.get_freelancer_hr_by_day(date, date)
  to authenticated, service_role;

-- ============================================================================
-- SECTION 2 (B2): get_freelancer_hr_daily_log — drill-down รายเคสของ author ในช่วงวัน
--   join contracts เอา contract_no + customer_name (คอลัมน์จริงยืนยันจาก 0001_init.sql)
--   order by created_at (เวลาจริง — ไล่ลำดับการทำงานในวัน)
--   guard เดียวกับ B1 (ไม่ผูก p_author เข้ากับ auth.uid — เป็นรายงานหัวหน้าดูของลูกทีมได้)
-- ============================================================================

create or replace function public.get_freelancer_hr_daily_log(
  p_author uuid,
  p_start  date,
  p_end    date
)
returns table (
  id                      uuid,
  created_at              timestamptz,
  contract_id             uuid,
  contract_no             text,
  customer_name           text,
  contact_method          text,
  contact_target          text,
  contact_person_name     text,
  contact_person_relation text,
  follow_up_result        text,
  next_follow_up_at       timestamptz,
  promised_amount         numeric,
  counts_as_demand        boolean,
  note_text               text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    f.id,
    f.created_at,
    f.contract_id,
    c.contract_no,
    c.customer_name,
    f.contact_method,
    f.contact_target,
    f.contact_person_name,
    f.contact_person_relation,
    f.follow_up_result,
    f.next_follow_up_at,
    f.promised_amount,
    f.counts_as_demand,
    f.note_text
  from public.follow_ups f
  join public.contracts c on c.id = f.contract_id
  where f.author_id = p_author
    and (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
    and (public.is_admin() or public.is_staff() or public.is_executive())
  order by f.created_at;
$$;

grant execute on function public.get_freelancer_hr_daily_log(uuid, date, date)
  to authenticated, service_role;

-- ============================================================================
-- SECTION 3: Verify / Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 3a) grant ครบ:
-- SELECT has_function_privilege('authenticated','public.get_freelancer_hr_by_day(date,date)','EXECUTE');        -- true
-- SELECT has_function_privilege('authenticated','public.get_freelancer_hr_daily_log(uuid,date,date)','EXECUTE'); -- true
-- SELECT has_function_privilege('service_role','public.get_freelancer_hr_by_day(date,date)','EXECUTE');          -- true

-- 3b) รันได้ไม่ error (1 เดือนจริง) — admin/staff/exec token เห็น rows:
-- SELECT * FROM public.get_freelancer_hr_by_day('2026-07-01','2026-07-13');
-- invariant ต่อแถว: logs_total >= reached_count, logs_total >= attempts_count,
--                   debtor_count + other_count = logs_total, demands_count <= debtor_count,
--                   morning+afternoon+evening <= logs_total
-- SELECT day, logs_total, reached_count, attempts_count, debtor_count, other_count,
--        demands_count, morning_count, afternoon_count, evening_count
--   FROM public.get_freelancer_hr_by_day('2026-07-01','2026-07-13')
--  WHERE reached_count > logs_total OR attempts_count > logs_total
--     OR (debtor_count + other_count) <> logs_total OR demands_count > debtor_count;
-- expected: 0 rows

-- 3c) drill-down รายเคส (ใช้ author_id จริงจาก 3b):
-- SELECT id, created_at, contract_no, customer_name, contact_target, follow_up_result, counts_as_demand
--   FROM public.get_freelancer_hr_daily_log('<author-uuid>','2026-07-01','2026-07-13')
--  ORDER BY created_at;

-- 3d) freelancer/anon token → 0 rows (guard ยังกัน):
-- (ทดสอบด้วย token freelancer ผ่าน REST — SELECT ... ต้องได้ 0 rows)
