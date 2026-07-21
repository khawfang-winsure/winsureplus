-- 0122: แก้ recovered_baht ใน get_collector_recoveries ให้อ่านจาก installments ตรง แทน payment_log
--
-- อ่านก่อนเขียน: 0120 (RPC เดิม เต็ม comment นิยาม/exclude/last-touch — logic เหล่านั้น "ไม่แตะเลย")
--                0121 (perf fix — โครง candidate_contract_ids/eligible_contracts/inst คงไว้ทั้งหมด)
--
-- ============================================================================
-- ปัญหาจริงบน production (Pete ยืนยันตัวเลข):
--   ช่วง 2026-05-23..2026-06-21 → events=88, matched_payment=9, no_payment_row=79 (90%), baht=24,445
--   สาเหตุ: installments นำเข้าจาก PJ สมัยก่อนตั้ง paid_at ไว้ แต่ไม่ได้สร้างแถว payment_log คู่กัน
--   → join ด้วยวันที่ (pod.pay_date = a.event_date) หาเงินไม่เจอ 90% ของเหตุการณ์ นับเป็น 0 บาท
--   (ตรวจแล้ว "ไม่ใช่" ปัญหาวันที่เหลื่อม — แถวที่มี installment_id ตรงกัน วันตรงกัน 94.7%)
--
-- แก้: เปลี่ยนแหล่งที่มา recovered_baht จาก payment_log → installments โดยตรง (ตารางเดียวกับที่ใช้คำนวณ
-- after_arrears/before_arrears อยู่แล้ว ไม่ต้องพึ่งแถว payment_log คู่กันอีก) — ลบ CTE payments_on_date ทิ้ง
-- (ได้ประโยชน์ perf เพิ่ม: ตัด join payment_log ทั้งก้อนออก)
--
-- นิยามใหม่ (ตาม Pete สั่ง): recovered_baht ของเหตุการณ์ (contract C, วันที่ D) =
--   ผลรวมยอดของ "งวดที่ค้างอยู่ (due_date < D) และถูกปิดในวัน D พอดี (cleared_date = D)"
--   — นี่คือชุดแถวเดียวกันเป๊ะกับที่ใช้คำนวณ closing_paid_ts อยู่แล้วใน CTE states (เดิมเอาแค่ max(paid_at)
--   ของกลุ่มนี้ไปทำ last-touch window — ตอนนี้เพิ่ม sum(ยอด) ของกลุ่มเดียวกันไปด้วยในรอบเดียว)
--
-- ============================================================================
-- เลือกคอลัมน์ไหน: installments.amount vs installments.paid_amount
-- ============================================================================
-- ตรวจ schema จริงจาก 0001_init.sql + 0011_payment_audit.sql:
--   amount        numeric not null default 0   -- ยอดงวด "ตามตาราง" (scheduled) ตั้งตอนสร้างสัญญา ไม่เปลี่ยน
--   paid_amount   numeric not null default 0   -- ยอด "จ่ายสะสมจริง" ของงวดนั้น (0011: จ่ายหลายครั้งบวกกันได้
--                                                  paid_at ถูกตั้งก็ต่อเมื่อ paid_amount >= amount เท่านั้น)
--   0011 มี backfill ครั้งเดียวตอนสร้างคอลัมน์: `update installments set paid_amount = amount
--   where paid_at is not null and paid_amount = 0` — เท่ากับ "งวดที่ปิดไปแล้วก่อน 0011 ทุกแถว (รวมงวด
--   นำเข้าจาก PJ ที่ตั้ง paid_at ตรงๆ ไม่ผ่าน RPC จ่ายเงิน) ถูก backfill paid_amount = amount แล้ว"
--
-- เลือก paid_amount เป็นหลัก เพราะ recovered_baht ควรสื่อ "เงินที่เก็บได้จริง" ไม่ใช่ยอดตามตาราง — สัญญาที่
-- restructure/แก้ยอดงวดภายหลัง (เช่น edit ผ่าน payment_log action='edit') paid_amount จะสะท้อนของจริง
-- ส่วน amount อาจไม่ตรงในบางเคสเก่า
--
-- จัดการกรณี "null/0 ผิดที่": ทั้งสองคอลัมน์ NOT NULL DEFAULT 0 (ไม่มี null จริงได้จาก constraint) แต่มีความ
-- เสี่ยงเชิงข้อมูลที่ทำให้เกิดบั๊กแบบเดียวกันซ้ำในรูปแบบใหม่ได้: ถ้ามีแถวที่ paid_at ถูกตั้ง (ปิดแล้ว) แต่
-- paid_amount ยังเป็น 0 (เช่น สคริปต์ import ใหม่กว่า 0011 ที่ insert ตรงไม่ผ่าน backfill/RPC) — ผลรวมจะ
-- กลายเป็น 0 บาท ซ้ำปัญหาเดิมในอีกรูปแบบ จึงกันด้วย `coalesce(nullif(paid_amount, 0), amount, 0)`:
-- ถ้า paid_amount = 0 ทั้งที่งวดปิดแล้ว → fallback ไปใช้ amount (ยอดตามตาราง) แทนที่จะปล่อยเป็น 0 เงียบๆ
-- (เคส "งวดปิดจริงด้วยยอด 0" มีได้ตามทฤษฎีถ้า amount ตั้งไว้ 0 ตั้งแต่แรก — fallback คืนค่า 0 ถูกต้องเหมือนกัน)
-- ============================================================================

-- ---------- recreate RPC 3 (signature/columns เดิมเป๊ะ — ไม่แตะ RPC 1/RPC 2) ----------

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
  -- [0121] หาสัญญาที่ "มีงวดจ่ายครบในช่วงที่ขอ" ก่อน ด้วย index installments_paid_at_idx — ไม่แตะ (perf)
  candidate_contract_ids as (
    select distinct i.contract_id
    from public.installments i
    where i.paid_at >= (p_start::timestamp at time zone 'Asia/Bangkok')
      and i.paid_at <  ((p_end + 1)::timestamp at time zone 'Asia/Bangkok')
      and coalesce(i.settled, false) = false
  ),
  eligible_contracts as (
    select cci.contract_id
    from candidate_contract_ids cci
    join public.contracts c on c.id = cci.contract_id
    where c.settled_at is null
      and not exists (
        select 1 from excluded_contracts ex where ex.contract_id = cci.contract_id
      )
  ),
  -- งวดของ "เฉพาะสัญญาที่เข้าข่ายจริง" — เพิ่ม amount/paid_amount + closing_value (0122) เพื่อคำนวณ
  -- recovered_baht จาก installments ตรง แทนการพึ่ง payment_log
  inst as (
    select
      i.id,
      i.contract_id,
      i.due_date,
      i.paid_at,
      coalesce(nullif(i.paid_amount, 0), i.amount, 0) as closing_value,
      case when i.paid_at is not null
        then (i.paid_at at time zone 'Asia/Bangkok')::date
      end as cleared_date
    from public.installments i
    join eligible_contracts ec on ec.contract_id = i.contract_id
    where coalesce(i.settled, false) = false
  ),
  -- วันที่จ่ายจริง (candidate event date) ที่อยู่ในช่วงที่ขอ — logic เดิมเป๊ะ
  candidates as (
    select distinct contract_id, cleared_date as event_date
    from inst
    where cleared_date is not null
      and cleared_date between p_start and p_end
  ),
  -- สถานะค้าง ก่อน/หลัง วัน D ต่อสัญญา + timestamp งวดที่ปิดรอยค้างสุดท้าย + [0122] ยอดที่ปิดรอยค้างวันนั้น
  -- (sum ของ closing_value เฉพาะงวด due_date < D และ cleared_date = D พอดี — ชุดแถวเดียวกับ closing_paid_ts)
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
      ) as closing_paid_ts,
      sum(i.closing_value) filter (
        where i.due_date < cand.event_date
          and i.cleared_date = cand.event_date
      ) as closing_baht
    from candidates cand
    join inst i on i.contract_id = cand.contract_id
    group by cand.contract_id, cand.event_date
  ),
  recovery_events as (
    select
      contract_id,
      event_date,
      closing_paid_ts,
      coalesce(closing_baht, 0)::numeric as closing_baht
    from states
    where after_arrears = 0 and before_arrears > 0
  ),
  -- last-touch attribution — copy หลักการจาก 0098 get_collector_scorecard เป๊ะ (ไม่แตะ)
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
  -- attribution: left join กลับ recovery_events ทุกแถว — ไม่มีสายนำ → author_id = null (ไม่ทิ้งแถว)
  -- [0122] carry closing_baht ผ่านมาถึงตรงนี้ (เดิม carry แค่ contract_id/event_date แล้วไป join payment_log
  -- แยกต่างหากที่ final select — ตอนนี้ยอดคำนวณเสร็จแล้วตั้งแต่ states ไม่ต้อง join เพิ่ม)
  attribution as (
    select
      re.contract_id,
      re.event_date,
      re.closing_baht,
      lt.winner_author_id as author_id
    from recovery_events re
    left join last_touch lt
      on lt.contract_id = re.contract_id and lt.event_date = re.event_date
  )
  select
    a.author_id,
    coalesce(nullif(pr2.full_name, ''), au.email, '-') as author_name,
    count(*)::int              as recoveries,
    sum(a.closing_baht)::numeric as recovered_baht
  from attribution a
  left join public.profiles pr2 on pr2.id = a.author_id
  left join auth.users      au  on au.id  = a.author_id
  where public.is_admin() or public.is_staff() or public.is_executive()  -- guard: freelancer/anon → 0 rows
  group by a.author_id, coalesce(nullif(pr2.full_name, ''), au.email, '-');
$$;

grant execute on function public.get_collector_recoveries(date, date)
  to authenticated, service_role;

comment on function public.get_collector_recoveries(date, date) is
  'ปิดเคสสำเร็จ = ลูกค้าจ่ายจนหายค้างสนิท (arrears 0) ในช่วงวันที่ระบุ; ตัดสัญญาที่เคยขยาย/ปิดก่อนกำหนด/คืนเครื่อง; เครดิต last-touch 7 วันก่อนวันปิด (เหมือน get_collector_scorecard); ไม่มีสายนำ → author_id null; ห้าม dedupe (นับจำนวนครั้ง). [0122] recovered_baht อ่านจาก installments.paid_amount (fallback amount ถ้า 0) ของงวดที่ปิดรอยค้างพอดี — ไม่พึ่ง payment_log อีกต่อไป (เดิม join ด้วยวันที่กับ payment_log ทำให้ 90% ของเหตุการณ์ยุคนำเข้า PJ หาเงินไม่เจอ นับเป็น 0 บาท)';

-- ============================================================================
-- ⚠️ หมายเหตุจากน้องชีส: เซสชันที่เขียนไฟล์นี้ไม่มี MCP/DB access เลย (ไม่มี mcp__supabase__* / psql /
-- SUPABASE_DB_URL ให้ใช้) — ยังไม่ได้รันตรวจอะไรจริงสักบรรทัด ครีมต้องรันสิ่งต่อไปนี้ "ตามลำดับ" ผ่าน MCP
-- ก่อนจะถือว่า "เสร็จ" (Pete ล็อกไว้ใน CLAUDE.md ว่า migration ต้อง verify จริง ไม่ใช่แค่ apply ผ่าน)
--
-- ทั้ง guard `where public.is_admin() or public.is_staff() or public.is_executive()` เช็ค auth.uid() —
-- รันผ่าน MCP (service role, ไม่มี auth session) auth.uid()=null → เห็น 0 แถวเสมอ (ไม่ใช่บั๊ก) ทุก query
-- ด้านล่างเป็น "raw CTE ไม่มี guard" (แทนบรรทัด guard ด้วย WHERE true) ให้รันตรงๆ ได้เลย ไม่ต้องเรียกผ่านฟังก์ชัน
-- ============================================================================

-- ---------- STEP 0: รันก่อน apply migration นี้ — เก็บ baseline จากฟังก์ชันที่ live อยู่ตอนนี้ (0121) ----------
-- copy CTE เต็มจากไฟล์ 0121_collector_recoveries_perf_fix.sql (มี payments_on_date) มารันแบบ WHERE true
-- แทน guard สำหรับทั้ง 3 ช่วง แล้วบันทึกไว้เทียบ:
--   A) 2026-05-23..2026-06-21  → คาด recoveries รวม = 88, recovered_baht รวม ≈ 24,445 (ตัวเลขที่ Pete ให้มา)
--   B) 2026-06-22..2026-07-21  → คาด recoveries รวม = 502
--   C) 2026-07-15..2026-07-21  → คาด แยกราย author: คุณปุ๋ย 1/4,996 · คุณเจน 14/54,293 · ไม่มีสายนำ 102/327,629
--      (ตัวเลขนี้มาจาก comment ในไฟล์ 0121 เอง — เป็น baseline ปัจจุบันของฟังก์ชันที่ live)
--
-- SELECT sum(recoveries), sum(recovered_baht) FROM ( <0121 raw CTE ทั้งก้อน, WHERE true> ) x;  -- ต่อช่วง

-- ---------- STEP 1: apply migration 0122 ผ่าน mcp__supabase__apply_migration ----------

-- ---------- STEP 2: รัน 3 ช่วงเดิมกับฟังก์ชันใหม่ (raw CTE จากไฟล์นี้ ด้านบน, WHERE true) ----------
-- SELECT sum(recoveries), sum(recovered_baht) FROM ( <0122 raw CTE ทั้งก้อน, WHERE true> ) x;  -- ต่อช่วง

-- ---------- STEP 3: recoveries (จำนวนครั้ง) ต้องเท่าเดิมเป๊ะ ----------
-- A: sum(recoveries) เก่า vs ใหม่ ต้อง = 88 ทั้งคู่
-- B: sum(recoveries) เก่า vs ใหม่ ต้อง = 502 ทั้งคู่
-- C: แยกราย author เก่า vs ใหม่ ต้องตรงเป๊ะทุกแถว: คุณปุ๋ย=1, คุณเจน=14, author_id null=102
-- (ถ้าไม่ตรง = recovery_events เปลี่ยนไป → หยุดทันที ห้าม deploy ต่อ มี bug ใน CTE)

-- ---------- STEP 4: ตารางเทียบ recovered_baht เก่า vs ใหม่ ต่อช่วง (กรอกหลังรัน STEP 0/2) ----------
-- | ช่วง | เก่า (payment_log join) | ใหม่ (installments ตรง) | หมายเหตุ |
-- |------|--------------------------|---------------------------|----------|
-- | A 05-23..06-21 | 24,445 (baseline Pete ให้) | _____ | คาดเพิ่มขึ้นมาก (90% เคยได้ 0 บาท) |
-- | B 06-22..07-21 | _____ | _____ | คาดขยับเล็กน้อย (ข้อมูลใหม่กว่า มี payment_log ครบกว่า) |
-- | C 07-15..07-21 | 4,996+54,293+327,629 = 386,918 | _____ | คาดขยับเล็กน้อย (อาจน้อยลงได้ถ้าเดิมนับรวมยอดจ่ายวันเดียวกันที่ไม่เกี่ยวกับการปิดรอยค้าง) |

-- ---------- STEP 5: sanity — ต้องไม่มี recovery event ไหนได้ 0 บาท (ก่อนกรุ๊ปตาม author) ----------
-- นับที่ระดับ "เหตุการณ์" ไม่ใช่ระดับ author-group (กันเคสกลุ่มบวกกันแล้วดูเหมือนไม่ใช่ 0 แต่มีบางเหตุการณ์เป็น 0 ปนอยู่):
-- WITH recovery_events_raw AS ( <copy CTE 0122 ทั้งก้อนถึงแค่ recovery_events, WHERE true> )
-- SELECT count(*) FROM recovery_events_raw WHERE closing_baht IS NULL OR closing_baht = 0;
-- -- expected: 0 แถว (ถ้า >0 = มีงวดปิดรอยค้างที่ amount และ paid_amount เป็น 0 ทั้งคู่จริง — ตรวจเป็นรายเคส
-- --    ก่อนสรุปว่าเป็นข้อมูลถูกต้อง (งวด 0 บาทจริง) หรือข้อมูลเสีย)

-- ---------- STEP 6: วัดเวลา — ต้องไม่ช้าลงกว่าเดิม ----------
-- EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.get_collector_recoveries('2026-06-22','2026-07-21');
-- -- เป้าหมาย: ยังอยู่ระดับ ≈2.7 วิ หรือเร็วกว่าเดิม (ตัด join payment_log ทั้งก้อนออกไปแล้ว ควรเร็วขึ้นเล็กน้อย)
-- EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.get_collector_recoveries('2026-05-23','2026-06-21');
-- -- เป้าหมาย: ยังอยู่ระดับ ≈1.0 วิ หรือเร็วกว่าเดิม
-- (guard บล็อกให้ 0 แถวใน EXPLAIN นี้เหมือนกัน — แต่ EXPLAIN ANALYZE ยัง "รันจริง" ทุก CTE ก่อนกรอง guard
-- ชั้นนอกสุด ดังนั้นเวลาที่วัดได้ยังสะท้อนต้นทุนจริงของ query แม้ผลลัพธ์ที่เห็นจะเป็น 0 แถว)

-- ---------- STEP 7: ยืนยัน grant ยังอยู่ครบ (ไม่มีอะไรเปลี่ยนจาก 0121 แต่เช็คซ้ำเป็นนิสัย) ----------
-- SELECT has_function_privilege('authenticated', 'public.get_collector_recoveries(date,date)', 'EXECUTE');  -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_recoveries(date,date)', 'EXECUTE');  -- true
