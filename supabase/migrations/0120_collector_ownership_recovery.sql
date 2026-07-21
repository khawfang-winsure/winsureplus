-- 0120: เพิ่ม 3 RPC สำหรับหน้า "ความเป็นเจ้าของเคส + ผลงานปิดค้าง" ของทีมตามหนี้
-- Pete ขอ: 1) ใครถือเกรดไหน + เคสค้างในขอบเขต/ที่กดรับจริง 2) กองกลาง (เกรดไม่มีใครถือ)
--          3) ปิดเคสสำเร็จ (ลูกค้าจ่ายจนหายค้าง) ให้เครดิตใคร
--
-- อ่านก่อนเขียน (ตามที่ครีมสั่ง):
--   0098 exec_collector_scorecard  — last-touch attribution CTE (RPC3 copy หลักการมาเป๊ะ)
--   0118 collector_collection_by_bucket — pattern guard/grant/comment ล่าสุด
--   0090 v_contract_status_include_returned — days_late/overdue_amount/grade/bucket
--   0018 freelancer_role (freelancer_grade_assignments) / 0086 case_assignment (assigned_to/assigned_at)
--   0013 extensions — restructure_contract ลบแถว installments ที่ยังไม่จ่ายทิ้งจริง (ประวัติค้างก่อนขยายกู้คืนไม่ได้)
--   0078 early_settlement — settle_contract_early ตั้ง installments.settled=true + paid_at=now() ให้ทุกงวดพร้อมกัน
--
-- additive only: create or replace function ใหม่ทั้ง 3 ตัว ไม่แตะตาราง/ฟังก์ชันอื่น ไม่มี ALTER ตาราง

-- ============================================================================
-- RPC 1: get_collector_ownership(p_start, p_end)
-- 1 แถวต่อ freelancer ที่ "ถือเกรดอยู่ตอนนี้" (ended_at is null) — คนถือเกรดแต่ไม่มีเคสค้างเลย
-- ต้องยังโผล่เป็นแถว (ค่า 0) เพราะ base population คือ grades_per_author ไม่ใช่เคสที่มีอยู่จริง
--
-- ⚠️ scope_cases/scope_baht นับซ้ำข้ามคนโดยตั้งใจ: ถ้าเกรดเดียวมีหลายคนถือ (Pete ยืนยันมีจริง เช่น
--    เกรด A มี 2 คนถือพร้อมกัน) ทุกคนที่ถือเกรดนั้นจะเห็นก้อนเคสเดียวกันเต็มจำนวน — นี่คือพฤติกรรมที่
--    ตั้งใจ (ไม่ใช่บั๊ก) ห้ามหารเฉลี่ยหรือ dedupe ข้ามคน — ดังนั้น Σ scope_baht ของทุกคนรวมกัน
--    "ไม่เท่ากับ" ยอดพอร์ตค้างจริงทั้งระบบ (จะสูงกว่าเสมอถ้ามีเกรดที่แชร์กัน) — ใช้ max_sharers
--    เตือนบน UI ว่าตัวเลขนี้อาจถูกนับซ้ำกี่คน
-- ============================================================================

create or replace function public.get_collector_ownership(
  p_start date,
  p_end   date
)
returns table (
  author_id      uuid,
  author_name    text,
  grades         text,     -- เกรดที่ถืออยู่ตอนนี้ เช่น 'A, B' (เรียงตามตัวอักษร)
  scope_cases    int,      -- เคสค้าง (days_late>0) ในเกรดที่ตัวเองถือ — นับซ้ำข้ามคนตั้งใจ ดูคอมเมนต์บนไฟล์
  scope_baht     numeric,
  max_sharers    int,      -- จำนวนคนมากสุดที่แชร์เกรดเดียวกับตัวเอง (เตือนนับซ้ำบน UI)
  claimed_cases  int,      -- เคสค้างที่ assigned_to = ตัวเอง (กดรับเคสจริง ไม่ใช่แค่ขอบเขตเกรด)
  claimed_baht   numeric,
  touched_cases  int       -- เคสในขอบเขตที่มี follow_ups ของตัวเองอย่างน้อย 1 ครั้งในช่วง p_start..p_end
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- freelancer active ที่ถือเกรดอยู่ตอนนี้ (ended_at is null)
  active_assignments as (
    select fga.freelancer_id, fga.grade
    from public.freelancer_grade_assignments fga
    join public.profiles pr
      on pr.id = fga.freelancer_id
      and pr.role = 'freelancer'
      and pr.active = true
    where fga.ended_at is null
  ),
  -- base population ของ RPC นี้ — เกรดที่แต่ละคนถือ รวมเป็น string (คนไม่มีเคสค้างก็ยังโผล่แถว)
  grades_per_author as (
    select
      freelancer_id as author_id,
      string_agg(grade, ', ' order by grade) as grades
    from active_assignments
    group by freelancer_id
  ),
  -- จำนวนคนที่ถือแต่ละเกรด (ใช้เตือนนับซ้ำ)
  sharers_per_grade as (
    select grade, count(distinct freelancer_id) as sharers
    from active_assignments
    group by grade
  ),
  max_sharers_per_author as (
    select
      aa.freelancer_id as author_id,
      max(spg.sharers)  as max_sharers
    from active_assignments aa
    join sharers_per_grade spg on spg.grade = aa.grade
    group by aa.freelancer_id
  ),
  -- เคสค้างจริง (days_late>0, active/returned) แยกตามเกรด — ก้อนเดียวต่อเกรด (ยังไม่คูณคน)
  arrears_by_grade as (
    select grade, count(*) as cases, sum(overdue_amount) as baht
    from public.v_contract_status
    where days_late > 0 and status in ('active','returned') and grade is not null
    group by grade
  ),
  -- scope ต่อคน = รวมก้อนเคสค้างของทุกเกรดที่ตัวเองถือ (คนถือหลายเกรด → บวกกัน; คนถือเกรดเดียวกับคนอื่น → เห็นก้อนเดียวกันเต็ม)
  scope_per_author as (
    select
      aa.freelancer_id as author_id,
      sum(coalesce(ar.cases, 0)) as scope_cases,
      sum(coalesce(ar.baht, 0))  as scope_baht
    from active_assignments aa
    left join arrears_by_grade ar on ar.grade = aa.grade
    group by aa.freelancer_id
  ),
  -- เคสที่กดรับจริง (assigned_to) และยังค้าง — ไม่ผูกกับ scope เกรด (อาจกดรับเคสนอกเกรดปัจจุบันได้)
  claimed as (
    select
      c.assigned_to as author_id,
      count(*)                as claimed_cases,
      sum(vs.overdue_amount)  as claimed_baht
    from public.contracts c
    join public.v_contract_status vs on vs.contract_id = c.id
    where c.assigned_to is not null
      and vs.days_late > 0
      and vs.status in ('active','returned')
    group by c.assigned_to
  ),
  -- เคสในขอบเขตเกรดของตัวเอง (ค้างจริง) ที่มี follow_up ของตัวเองอย่างน้อย 1 ครั้งในช่วง
  touched as (
    select
      aa.freelancer_id       as author_id,
      count(distinct vs.contract_id) as touched_cases
    from active_assignments aa
    join public.v_contract_status vs
      on vs.grade = aa.grade
     and vs.days_late > 0
     and vs.status in ('active','returned')
    join public.follow_ups f
      on f.contract_id = vs.contract_id
     and f.author_id = aa.freelancer_id
     and (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
    group by aa.freelancer_id
  )
  select
    gpa.author_id,
    coalesce(nullif(pr.full_name, ''), au.email, '-')  as author_name,
    gpa.grades,
    coalesce(sc.scope_cases, 0)::int                    as scope_cases,
    coalesce(sc.scope_baht, 0)::numeric                 as scope_baht,
    coalesce(ms.max_sharers, 0)::int                    as max_sharers,
    coalesce(cl.claimed_cases, 0)::int                  as claimed_cases,
    coalesce(cl.claimed_baht, 0)::numeric                as claimed_baht,
    coalesce(tc.touched_cases, 0)::int                  as touched_cases
  from grades_per_author gpa
  left join scope_per_author       sc  on sc.author_id = gpa.author_id
  left join max_sharers_per_author ms  on ms.author_id = gpa.author_id
  left join claimed                cl  on cl.author_id = gpa.author_id
  left join touched                tc  on tc.author_id = gpa.author_id
  left join public.profiles pr on pr.id = gpa.author_id
  left join auth.users      au on au.id = gpa.author_id
  where public.is_admin() or public.is_staff() or public.is_executive();  -- guard: freelancer/anon → 0 rows
$$;

grant execute on function public.get_collector_ownership(date, date)
  to authenticated, service_role;

comment on function public.get_collector_ownership(date, date) is
  'ความเป็นเจ้าของเคสต่อคนตามหนี้: เกรดที่ถือ + เคสค้างในขอบเขตเกรด(นับซ้ำข้ามคนตั้งใจ ดู max_sharers) + เคสที่กดรับจริง(assigned_to) + เคสที่มี follow-up ของตัวเองในช่วง';

-- ============================================================================
-- RPC 2: get_unowned_arrears() — "กองกลาง" ณ ปัจจุบัน ไม่รับพารามิเตอร์ (เป็นสถานะ ณ ตอนนี้)
-- เคสค้างที่ "เกรดไม่มีใครถือเลย" (ไม่ใช่แค่ยังไม่กดรับ — กันทับซ้อนกับ RPC 1 ซึ่งนับตามคนที่ถือเกรด)
-- รวม current_grade is null ด้วย label '(ไม่มีเกรด)'
-- ============================================================================

create or replace function public.get_unowned_arrears()
returns table (
  grade text,
  cases int,
  baht  numeric
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- เกรดที่มี freelancer active ถืออยู่ตอนนี้ (ended_at is null) — เกรดนอกลิสต์นี้ = ไม่มีใครถือ
  held_grades as (
    select distinct fga.grade
    from public.freelancer_grade_assignments fga
    join public.profiles pr
      on pr.id = fga.freelancer_id
      and pr.role = 'freelancer'
      and pr.active = true
    where fga.ended_at is null
  ),
  unowned as (
    select
      coalesce(vs.grade, '(ไม่มีเกรด)') as grade_label,
      vs.overdue_amount
    from public.v_contract_status vs
    where vs.days_late > 0
      and vs.status in ('active','returned')
      and (vs.grade is null or vs.grade not in (select grade from held_grades))
  )
  select
    u.grade_label            as grade,
    count(*)::int            as cases,
    sum(u.overdue_amount)::numeric as baht
  from unowned u
  where public.is_admin() or public.is_staff() or public.is_executive()  -- guard: freelancer/anon → 0 rows
  group by u.grade_label;
$$;

grant execute on function public.get_unowned_arrears()
  to authenticated, service_role;

comment on function public.get_unowned_arrears() is
  'กองกลาง: เคสค้าง (days_late>0, active/returned) ที่เกรดไม่มี freelancer active ถืออยู่เลย ณ ปัจจุบัน (ไม่ใช่แค่ยังไม่กดรับ) รวม current_grade null → label (ไม่มีเกรด)';

-- ============================================================================
-- RPC 3: get_collector_recoveries(p_start, p_end) — ปิดเคสสำเร็จ = ลูกค้าจ่ายจนหายค้าง (Pete ล็อก)
--
-- นิยามเหตุการณ์ "หายค้าง" ของสัญญา C ที่วันที่ D (เวลาไทย):
--   D = วันที่ของ installments.paid_at แถวใดแถวหนึ่งของสัญญา (cleared_date)
--   after_arrears(D)  = จำนวนงวด due_date < D ที่ ณ สิ้นวัน D ยังไม่จ่าย (cleared_date null หรือ > D)
--                        ต้อง = 0  (หายค้างสนิท ณ วันนี้)
--   before_arrears(D) = จำนวนงวด due_date < D ที่ "ก่อนหน้า D" ยังไม่จ่าย (cleared_date null หรือ >= D)
--                        ต้อง > 0  (ก่อนหน้านี้เคยค้างจริง — ไม่ใช่สัญญาที่ไม่เคยค้างเลย)
--   → คู่ (after=0, before>0) การันตีว่ามีอย่างน้อย 1 งวดที่ due_date<D และ cleared_date=D พอดี
--     (จ่ายวันนี้เองที่ทำให้หายค้าง) — ใช้เป็น "closing_paid_ts" (max paid_at ของงวดกลุ่มนี้)
--
-- ตัดออก (ไม่ใช่ผลงานคนโทร):
--   - สัญญาที่มีแถวใน contract_extensions → ตัดทั้งสัญญา (งวดค้างเก่าถูกลบจริงตอนขยาย คำนวณย้อนหลังไม่ได้)
--   - contracts.settled_at is not null (ปิดก่อนกำหนด — settle_contract_early ปิดทุกงวดพร้อมกัน)
--   - สัญญาที่มีแถวใน device_returns (คืนเครื่อง)
--   - งวดที่ settled=true (ปิดบัญชีทีเดียว ไม่ใช่จ่ายทีละงวด — กันเผื่อกรณีอื่นนอกจาก settled_at)
--
-- เครดิต: last-touch 7 วันก่อน closing_paid_ts — copy CTE จาก 0098 (get_collector_scorecard) เป๊ะ
--   (สายโทร contact_method='phone' ของ freelancer active, created_at < closing_ts, ภายใน 7 วัน,
--    ผู้ชนะคือสายล่าสุด) — ไม่มีสายนำ → author_id = null (ห้ามทิ้งเงียบ ต้องเห็นเป็นแถว author_id=null)
--
-- recovered_baht = ยอดที่จ่ายในวัน D ของสัญญานั้น (sum payment_log.amount action='pay' ของวันนั้น)
-- ห้าม dedupe — สัญญาเดียวหายค้างหลายครั้งในช่วง = นับหลายครั้ง (จำนวนครั้ง ไม่ใช่จำนวนสัญญา)
--
-- Performance: ใช้ join+aggregate (ไม่ใช่ correlated subquery ซ้อนลึก) — candidates จำกัดเฉพาะ
-- distinct (contract_id, cleared_date) ของสัญญา eligible เท่านั้น แล้ว join กลับ installments
-- เดียวกันของสัญญานั้น (ไม่ cross ข้ามสัญญา) — ขนาดงานต่อสัญญา = จำนวนงวดของสัญญานั้นเอง (≤ term_months)
-- ============================================================================

create or replace function public.get_collector_recoveries(
  p_start date,
  p_end   date
)
returns table (
  author_id       uuid,
  author_name     text,
  recoveries      int,
  recovered_baht  numeric
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  excluded_contracts as (
    select contract_id from public.contract_extensions
    union
    select contract_id from public.device_returns
  ),
  eligible_contracts as (
    select c.id as contract_id
    from public.contracts c
    where c.settled_at is null
      and not exists (
        select 1 from excluded_contracts ex where ex.contract_id = c.id
      )
  ),
  -- งวดของสัญญา eligible เท่านั้น, ตัดงวดที่ปิดบัญชีทีเดียว (settled=true) ทิ้ง
  inst as (
    select
      i.id,
      i.contract_id,
      i.due_date,
      i.paid_at,
      case when i.paid_at is not null
        then (i.paid_at at time zone 'Asia/Bangkok')::date
      end as cleared_date
    from public.installments i
    join eligible_contracts ec on ec.contract_id = i.contract_id
    where coalesce(i.settled, false) = false
  ),
  -- วันที่จ่ายจริง (candidate event date) ที่อยู่ในช่วงที่ขอ
  candidates as (
    select distinct contract_id, cleared_date as event_date
    from inst
    where cleared_date is not null
      and cleared_date between p_start and p_end
  ),
  -- สถานะค้าง ก่อน/หลัง วัน D ต่อสัญญา + timestamp งวดที่ปิดรอยค้างสุดท้าย
  states as (
    select
      cand.contract_id,
      cand.event_date,
      count(*) filter (
        where i.due_date < cand.event_date
          and (i.cleared_date is null or i.cleared_date > cand.event_date)
      )::int as after_arrears,
      count(*) filter (
        where i.due_date < cand.event_date
          and (i.cleared_date is null or i.cleared_date >= cand.event_date)
      )::int as before_arrears,
      max(i.paid_at) filter (
        where i.due_date < cand.event_date
          and i.cleared_date = cand.event_date
      ) as closing_paid_ts
    from candidates cand
    join inst i on i.contract_id = cand.contract_id
    group by cand.contract_id, cand.event_date
  ),
  recovery_events as (
    select contract_id, event_date, closing_paid_ts
    from states
    where after_arrears = 0 and before_arrears > 0
  ),
  -- ยอดที่จ่ายจริงในวัน D ของสัญญานั้น (ทุกก้อน 'pay' ในวันนั้น ไม่จำกัดแค่งวดที่ปิดรอยค้าง)
  payments_on_date as (
    select
      pl.contract_id,
      (pl.created_at at time zone 'Asia/Bangkok')::date as pay_date,
      sum(pl.amount) as amount
    from public.payment_log pl
    left join public.installments i on i.id = pl.installment_id
    where pl.action = 'pay'
      and coalesce(i.settled, false) = false
    group by pl.contract_id, (pl.created_at at time zone 'Asia/Bangkok')::date
  ),
  -- last-touch attribution — copy หลักการจาก 0098 get_collector_scorecard เป๊ะ (inner join เพื่อกรอง
  -- เฉพาะ freelancer active ก่อน แล้วค่อย distinct on เอาสายล่าสุดก่อน closing_paid_ts)
  candidate_touches as (
    select
      re.contract_id,
      re.event_date,
      f.author_id   as winner_author_id,
      f.created_at  as touch_ts
    from recovery_events re
    join public.follow_ups f
      on f.contract_id = re.contract_id
      and f.contact_method = 'phone'
      and f.created_at < re.closing_paid_ts
      and f.created_at >= re.closing_paid_ts - interval '7 days'
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
  ),
  last_touch as (
    select distinct on (contract_id, event_date)
      contract_id, event_date, winner_author_id
    from candidate_touches
    order by contract_id, event_date, touch_ts desc
  ),
  -- attribution: left join กลับ recovery_events ทุกแถว — ไม่มีสายนำ → winner_author_id = null (ไม่ทิ้งแถว)
  attribution as (
    select
      re.contract_id,
      re.event_date,
      lt.winner_author_id as author_id
    from recovery_events re
    left join last_touch lt
      on lt.contract_id = re.contract_id and lt.event_date = re.event_date
  )
  select
    a.author_id,
    coalesce(nullif(pr2.full_name, ''), au.email, '-') as author_name,
    count(*)::int                                       as recoveries,
    sum(coalesce(pod.amount, 0))::numeric                as recovered_baht
  from attribution a
  left join payments_on_date pod
    on pod.contract_id = a.contract_id and pod.pay_date = a.event_date
  left join public.profiles pr2 on pr2.id = a.author_id
  left join auth.users      au  on au.id  = a.author_id
  where public.is_admin() or public.is_staff() or public.is_executive()  -- guard: freelancer/anon → 0 rows
  group by a.author_id, coalesce(nullif(pr2.full_name, ''), au.email, '-');
$$;

grant execute on function public.get_collector_recoveries(date, date)
  to authenticated, service_role;

comment on function public.get_collector_recoveries(date, date) is
  'ปิดเคสสำเร็จ = ลูกค้าจ่ายจนหายค้างสนิท (arrears 0) ในช่วงวันที่ระบุ; ตัดสัญญาที่เคยขยาย/ปิดก่อนกำหนด/คืนเครื่อง; เครดิต last-touch 7 วันก่อนวันปิด (เหมือน get_collector_scorecard); ไม่มีสายนำ → author_id null; ห้าม dedupe (นับจำนวนครั้ง)';

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
--
-- ⚠️ ทั้ง 3 RPC มี guard `where public.is_admin() or public.is_staff() or public.is_executive()`
--    ซึ่งเช็คจาก auth.uid() — เมื่อรันผ่าน MCP (postgres/service role, ไม่มี auth session) auth.uid()
--    จะเป็น null → is_admin()/is_staff()/is_executive() ทั้งหมด false → เห็น 0 แถวเสมอ (ไม่ใช่บั๊ก)
--    ต้อง replicate CTE เดียวกันแบบ "ไม่มี guard" (ตัดบรรทัด where public.is_admin()... ออก /
--    เปลี่ยนเป็น where true) ถึงจะเห็นข้อมูลจริงตอน verify ผ่าน MCP
-- ============================================================================

-- 1) ตรวจ grant:
-- SELECT has_function_privilege('authenticated', 'public.get_collector_ownership(date,date)', 'EXECUTE');   -- true
-- SELECT has_function_privilege('authenticated', 'public.get_unowned_arrears()', 'EXECUTE');                -- true
-- SELECT has_function_privilege('authenticated', 'public.get_collector_recoveries(date,date)', 'EXECUTE');  -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_ownership(date,date)', 'EXECUTE');   -- true
-- SELECT has_function_privilege('service_role',  'public.get_unowned_arrears()', 'EXECUTE');                -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_recoveries(date,date)', 'EXECUTE');  -- true

-- 2) verify RPC 1 (guard ปิดกันไว้ — copy CTE ทั้งก้อนแล้วตัด "where public.is_admin()..." ออก):
-- WITH active_assignments AS (
--   SELECT fga.freelancer_id, fga.grade
--   FROM public.freelancer_grade_assignments fga
--   JOIN public.profiles pr ON pr.id = fga.freelancer_id AND pr.role = 'freelancer' AND pr.active = true
--   WHERE fga.ended_at IS NULL
-- ),
-- grades_per_author AS (
--   SELECT freelancer_id AS author_id, string_agg(grade, ', ' ORDER BY grade) AS grades
--   FROM active_assignments GROUP BY freelancer_id
-- ),
-- arrears_by_grade AS (
--   SELECT grade, count(*) AS cases, sum(overdue_amount) AS baht
--   FROM public.v_contract_status
--   WHERE days_late > 0 AND status IN ('active','returned') AND grade IS NOT NULL
--   GROUP BY grade
-- )
-- SELECT gpa.author_id, gpa.grades,
--        sum(coalesce(ar.cases,0)) AS scope_cases, sum(coalesce(ar.baht,0)) AS scope_baht
-- FROM grades_per_author gpa
-- JOIN active_assignments aa ON aa.freelancer_id = gpa.author_id
-- LEFT JOIN arrears_by_grade ar ON ar.grade = aa.grade
-- GROUP BY gpa.author_id, gpa.grades
-- ORDER BY scope_baht DESC;
-- -- expected: หลายแถว, เกรด A มี scope_cases ~248 (2 คนถือ = 2 แถวเห็นค่าเดียวกัน)

-- 3) verify RPC 2 (ตัด guard ออก แทนด้วย where true):
-- WITH held_grades AS (
--   SELECT DISTINCT fga.grade
--   FROM public.freelancer_grade_assignments fga
--   JOIN public.profiles pr ON pr.id = fga.freelancer_id AND pr.role = 'freelancer' AND pr.active = true
--   WHERE fga.ended_at IS NULL
-- )
-- SELECT coalesce(vs.grade, '(ไม่มีเกรด)') AS grade, count(*) AS cases, sum(vs.overdue_amount) AS baht
-- FROM public.v_contract_status vs
-- WHERE vs.days_late > 0 AND vs.status IN ('active','returned')
--   AND (vs.grade IS NULL OR vs.grade NOT IN (SELECT grade FROM held_grades))
-- GROUP BY coalesce(vs.grade, '(ไม่มีเกรด)');
-- -- expected: ถ้าทุกเกรด A-E มีคนถือครบ + ไม่มีสัญญา grade null ที่ค้าง → 0 แถว (ปกติของฐานตอนนี้)

-- 4) verify RPC 3 — cross-check เร็ว: จำนวน recovery event ทั้งหมด (ไม่ต้อง full CTE ก็เช็คได้เบื้องต้น)
-- SELECT count(*) FROM public.get_collector_recoveries('2026-06-01','2026-06-30');
-- -- expected: 0 แถว (guard บล็อก MCP) — ต้องรันแบบเต็ม CTE ไม่มี guard ด้านล่างแทน:
--
-- (สำหรับตรวจผลจริง: เอา body function ด้านบนทั้งก้อนมารัน แทนบรรทัด
--  `where public.is_admin() or public.is_staff() or public.is_executive()`
--  ในทั้ง 2 จุด (states/final select ไม่มี guard ใน states — มีแค่จุดเดียวคือ final select) ด้วย `where true`
--  แล้วรันเป็น SELECT ตรงๆ (ไม่ wrap เป็น function) เพื่อดู author_id/recoveries/recovered_baht จริง)

-- 5) sanity RPC 3: ไม่มี recovery event ของสัญญาที่เคยขยาย/ปิดก่อนกำหนด/คืนเครื่องหลุดมา:
-- (ใช้ query ข้อ 4 แบบไม่มี guard) เทียบ contract_id ที่ได้กับ:
-- SELECT contract_id FROM public.contract_extensions
-- UNION SELECT contract_id FROM public.device_returns
-- UNION SELECT id FROM public.contracts WHERE settled_at IS NOT NULL;
-- -- expected: ไม่มี contract_id ซ้ำกันเลย

-- 6) freelancer เรียกแล้วเห็น 0 rows/0 ทั้ง 3 ตัว (guard ยังกันอยู่) — ทดสอบด้วย token freelancer ผ่าน REST
