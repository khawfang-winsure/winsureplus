-- 0121: แก้ get_collector_recoveries ช้าจน statement timeout (57014) ช่วงวันที่กว้าง/ใหม่
-- อ่านก่อนเขียน: 0120 (RPC เดิม, comment เต็มเรื่อง logic/นิยาม/เครดิต last-touch — ตัวนี้ "ไม่แตะ logic เลย"
-- เปลี่ยนแค่ลำดับ/ขอบเขตการดึงข้อมูลก่อนกรอง)
--
-- อาการจริงบน production (ครีมดักจับจากหน้าเว็บ):
--   p_start 2026-05-23, p_end 2026-06-21  → 200 OK
--   p_start 2026-06-22, p_end 2026-07-21  → 500 {"code":"57014","message":"canceling statement due to statement timeout"}
--
-- ============================================================================
-- bottleneck ที่พบ (วิเคราะห์จาก schema/index จริง — ไม่มี MCP/DB access ในเซสชันนี้ ครีมต้อง
-- EXPLAIN ANALYZE ยืนยันเองผ่าน MCP ก่อน apply ตาม smoke SQL ท้ายไฟล์):
--
--   1) payments_on_date (RPC เดิม) ไม่มีตัวกรองวันที่เลย — สแกน payment_log "ทั้งตาราง" (ทุก action='pay'
--      ตั้งแต่เปิดระบบ) ทุกครั้งที่เรียก ทั้งที่ผลลัพธ์สุดท้ายใช้แค่แถวที่ pay_date ตรงกับ a.event_date
--      ซึ่งถูกบังคับให้อยู่ใน [p_start,p_end] อยู่แล้ว (มาจาก candidates/recovery_events) — แถวนอกช่วง
--      ไม่มีทางแมตช์เลย ตัดทิ้งได้ปลอดภัย 100% โดยไม่กระทบผลลัพธ์ (พิสูจน์ด้วย join key ไม่ใช่แค่ optimization เดา)
--      ยิ่ง payment_log โตเรื่อยๆ (ทุกจ่าย/แก้/ยกเลิกบันทึก 1 แถว) ยิ่งช้าขึ้นทุกเดือนแม้ query ช่วงสั้นก็ตาม
--      payment_log ไม่เคยมี index บน created_at เลย (มีแค่ installment_id, contract_id จาก 0011) —
--      แม้เติมตัวกรองวันที่ ก็ยัง full-scan อยู่ดีถ้าไม่มี index รองรับ → เพิ่ม partial index (action='pay')
--
--   2) inst (RPC เดิม) ดึงงวดของ "ทุกสัญญา eligible ทั้งฐาน" (~2,500+ สัญญา ~29,000 แถว installments)
--      มาก่อน แล้วค่อยกรอง cleared_date ในช่วงทีหลัง (ผ่าน candidates) — สัญญาที่ไม่มีงวดจ่ายครบใน
--      ช่วงที่ขอเลยสักงวด ก็ยังถูกดึงประวัติทั้งสัญญามาโดยเปล่าประโยชน์ (ไม่มีทางโผล่ใน candidates อยู่ดี)
--      installments ไม่เคยมี index บน paid_at เลย (มีแค่ partial index where paid_at is null สำหรับหน้า
--      ค้างชำระ) → หาสัญญาที่ "มีงวดจ่ายครบในช่วง" ต้องสแกนเต็มตารางทุกครั้ง
--
--   3) device_returns ไม่เคยมี index บน contract_id เลย (ใช้เป็น anti-join ใน excluded_contracts) —
--      ตารางเล็ก ผลกระทบน้อยกว่า 1-2 แต่เป็นช่องโหว่เดียวกัน (FK ไม่มี index) เก็บให้ครบตามที่ควร
--
--   ทำไมช่วงเก่า (พ.ค.-มิ.ย.) รอดแต่ช่วงใหม่ (มิ.ย.-ก.ค.) timeout ทั้งที่ยาว 30 วันเท่ากัน:
--   ต้นทุนคงที่จาก (1)+(2) เท่ากันทุกครั้งไม่ว่าถามช่วงไหน (สแกนทั้งตารางเสมอ) — และต้นทุนนี้โตขึ้นเรื่อยๆ
--   ตามขนาด payment_log/installments ที่เพิ่มทุกวัน บวกกับต้นทุนแปรผันจากจำนวน recovery event +
--   follow_ups ในช่วงที่ขอ (ช่วงหลังมีงานทีมโทรมากขึ้นจาก multi-log ที่ปลดล็อก 13 ก.ค.) — รวมกันเกิน
--   8 วินาที เฉพาะช่วงใหม่ที่ชนกับทั้งข้อมูลสะสมเยอะขึ้น + event ในช่วงเยอะขึ้น
--
-- แก้ (การันตี "ผลลัพธ์เชิงตัวเลขเหมือนเดิมเป๊ะ" — logic การนับ/เครดิต/exclude ไม่แตะเลย แค่ปรับลำดับ
-- CTE ให้กรองด้วย index ก่อน แล้วค่อยขยาย join แทนที่จะขยายก่อนกรองทีหลัง):
--   - payments_on_date: เติม pl.created_at ในช่วง [p_start, p_end+1) แบบ timestamptz กรุงเทพ (เทียบเท่า
--     cleared_date ตัวเดิมทุกประการ พิสูจน์ในคอมเมนต์ในฟังก์ชัน) + partial index รองรับ
--   - เพิ่ม candidate_contract_ids: หาสัญญาที่ "มีงวดจ่ายครบในช่วงที่ขอ" ก่อน (index installments_paid_at_idx)
--     แล้วค่อยไป join eligible_contracts/inst เฉพาะสัญญากลุ่มนี้ (ไม่ใช่ทุกสัญญา eligible ทั้งฐาน) —
--     inst ยังคงดึง "ประวัติทั้งสัญญา" เหมือนเดิม (จำเป็นสำหรับคำนวณ before/after arrears) แค่ขอบเขต
--     "สัญญาไหนบ้าง" เล็กลงมาก
--   - เพิ่ม index installments(paid_at) partial, payment_log(created_at) partial where action='pay',
--     device_returns(contract_id)
--
-- ⚠️ RPC 1 (get_collector_ownership) และ RPC 2 (get_unowned_arrears) ไม่แตะ — ไม่มีปัญหา timeout รายงาน
-- ============================================================================

-- ---------- index ใหม่ (additive, ปลอดภัย ไม่กระทบ query อื่น) ----------

-- ใช้โดย get_collector_recoveries: หาสัญญาที่มีงวดจ่ายครบในช่วงวันที่ขอ (candidate_contract_ids)
-- แทนสแกน installments ทั้งตาราง (~29,000 แถว) ทุกครั้งที่เรียก
create index if not exists installments_paid_at_idx
  on public.installments (paid_at)
  where paid_at is not null;

-- ใช้โดย get_collector_recoveries: payments_on_date เดิมสแกน payment_log ทั้งตาราง (ไม่กรองวันเลย)
-- partial index นี้ตรงกับเงื่อนไข action='pay' ในฟังก์ชันเป๊ะ → กรองช่วงวันที่ผ่าน index scan ได้ตรงๆ
create index if not exists payment_log_pay_created_idx
  on public.payment_log (created_at)
  where action = 'pay';

-- ใช้โดย excluded_contracts (anti-join กันสัญญาคืนเครื่องออกจากผลลัพธ์) — FK นี้ไม่เคยมี index เลยตั้งแต่ 0001
create index if not exists device_returns_contract_idx
  on public.device_returns (contract_id);

-- ---------- recreate RPC 3 (signature/columns เดิมเป๊ะ) ----------

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
  -- ⚡ 0121: หาสัญญาที่ "มีงวดจ่ายครบในช่วงที่ขอ" ก่อน ด้วย index installments_paid_at_idx —
  -- เทียบเท่า cleared_date = (paid_at at time zone 'Asia/Bangkok')::date between p_start and p_end เป๊ะ
  -- (แปลง p_start/p_end เป็นขอบเขต timestamptz กรุงเทพแทน: [p_start เที่ยงคืนกรุงเทพ, p_end+1 เที่ยงคืนกรุงเทพ) )
  -- ชุดแถว installments ที่ผ่านเงื่อนไขนี้ = ชุดเดียวกับ cleared_date-based ทุกประการ ไม่มีการเปลี่ยนผลลัพธ์
  candidate_contract_ids as (
    select distinct i.contract_id
    from public.installments i
    where i.paid_at >= (p_start::timestamp at time zone 'Asia/Bangkok')
      and i.paid_at <  ((p_end + 1)::timestamp at time zone 'Asia/Bangkok')
      and coalesce(i.settled, false) = false
  ),
  -- เดิม: eligible_contracts = ทุกสัญญา settled_at is null ไม่ถูก exclude (ทั้งฐาน) → ตอนนี้จำกัดแค่
  -- สัญญาที่ผ่าน candidate_contract_ids แล้วเท่านั้น (สัญญานอกกลุ่มนี้ไม่มีทางโผล่ใน candidates อยู่ดี
  -- เพราะไม่มีงวดจ่ายครบในช่วง — ตัดออกตั้งแต่ต้นไม่กระทบผลลัพธ์ปลายทาง)
  eligible_contracts as (
    select cci.contract_id
    from candidate_contract_ids cci
    join public.contracts c on c.id = cci.contract_id
    where c.settled_at is null
      and not exists (
        select 1 from excluded_contracts ex where ex.contract_id = cci.contract_id
      )
  ),
  -- งวดของ "เฉพาะสัญญาที่เข้าข่ายจริง" (เล็กลงมากจากเดิม) — ยังคงดึง "ประวัติทั้งสัญญา" ทุก due_date
  -- เหมือนเดิม (จำเป็นสำหรับคำนวณ before/after arrears ให้ถูก) ตัดงวดปิดบัญชีทีเดียว (settled=true) ทิ้ง
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
  -- วันที่จ่ายจริง (candidate event date) ที่อยู่ในช่วงที่ขอ — logic เดิมเป๊ะ
  candidates as (
    select distinct contract_id, cleared_date as event_date
    from inst
    where cleared_date is not null
      and cleared_date between p_start and p_end
  ),
  -- สถานะค้าง ก่อน/หลัง วัน D ต่อสัญญา + timestamp งวดที่ปิดรอยค้างสุดท้าย — logic เดิมเป๊ะ
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
  -- ⚡ 0121: เดิมสแกน payment_log ทั้งตาราง (ไม่มีตัวกรองวันเลย) ทุกครั้งที่เรียก — เติมตัวกรองช่วงวันที่
  -- ปลอดภัย 100% เพราะผลสุดท้าย join ด้วย pod.pay_date = a.event_date ซึ่งถูกบังคับให้อยู่ใน [p_start,p_end]
  -- อยู่แล้ว (มาจาก candidates/recovery_events) — แถวนอกช่วงไม่มีทางแมตช์ ตัดทิ้งได้โดยไม่กระทบผลลัพธ์
  payments_on_date as (
    select
      pl.contract_id,
      (pl.created_at at time zone 'Asia/Bangkok')::date as pay_date,
      sum(pl.amount) as amount
    from public.payment_log pl
    left join public.installments i on i.id = pl.installment_id
    where pl.action = 'pay'
      and pl.created_at >= (p_start::timestamp at time zone 'Asia/Bangkok')
      and pl.created_at <  ((p_end + 1)::timestamp at time zone 'Asia/Bangkok')
      and coalesce(i.settled, false) = false
    group by pl.contract_id, (pl.created_at at time zone 'Asia/Bangkok')::date
  ),
  -- last-touch attribution — copy หลักการจาก 0098 get_collector_scorecard เป๊ะ (ไม่แตะ) — recovery_events
  -- เล็กลงจากการกรองต้นทางแล้ว ทำให้ join กับ follow_ups (มี index อยู่แล้ว) เร็วขึ้นตามไปด้วย
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
  'ปิดเคสสำเร็จ = ลูกค้าจ่ายจนหายค้างสนิท (arrears 0) ในช่วงวันที่ระบุ; ตัดสัญญาที่เคยขยาย/ปิดก่อนกำหนด/คืนเครื่อง; เครดิต last-touch 7 วันก่อนวันปิด (เหมือน get_collector_scorecard); ไม่มีสายนำ → author_id null; ห้าม dedupe (นับจำนวนครั้ง). [0121] เดิม timeout ช่วงกว้าง/ใหม่ (57014) เพราะ payments_on_date/inst สแกนตารางเต็มไม่กรองวันที่ — แก้ด้วยกรองช่วงวันที่ + index ใหม่ ผลลัพธ์เชิงตัวเลขเหมือนเดิมทุกกรณี (ดูคอมเมนต์พิสูจน์ equivalence ในไฟล์ 0121)';

-- ============================================================================
-- ⚠️ หมายเหตุจากน้องชีส (สำคัญ — อ่านก่อน apply): เซสชันที่เขียนไฟล์นี้ไม่มี MCP/DB access เลย
-- (ไม่มี mcp__supabase__* / psql / SUPABASE_DB_URL ให้ใช้) จึงยังไม่ได้รัน EXPLAIN ANALYZE จริงและยัง
-- ไม่ได้รันตรวจผลลัพธ์ก่อน/หลังด้วยตัวเอง — ต้องให้ครีมรัน 3 ขั้นตอนด้านล่างผ่าน MCP หลัง apply แล้วเท่านั้น
-- ก่อนจะถือว่า "เสร็จ" (ตาม checklist ที่ Pete ล็อกไว้ใน CLAUDE.md ว่า migration ต้อง verify จริง)
--
-- ทั้ง 3 RPC มี guard `where public.is_admin() or public.is_staff() or public.is_executive()` ซึ่งเช็ค
-- auth.uid() — รันผ่าน MCP (service role, ไม่มี auth session) auth.uid()=null → เห็น 0 แถวเสมอ (ไม่ใช่บั๊ก)
-- ต้อง copy CTE ทั้งก้อนมารันแบบ SELECT ตรงๆ (ไม่เรียกผ่านฟังก์ชัน) แทนบรรทัด guard ด้วย WHERE true
-- ============================================================================

-- 1) เช็ค index ใหม่ถูกสร้างจริง:
-- SELECT indexname FROM pg_indexes WHERE indexname IN
--   ('installments_paid_at_idx','payment_log_pay_created_idx','device_returns_contract_idx');
-- -- expected: 3 แถว

-- 2) EXPLAIN (ANALYZE, BUFFERS) เทียบเวลาก่อน/หลัง — รันช่วงที่เคย timeout จริง (2026-06-22..2026-07-21)
--    ก) BASELINE (logic เดิมจาก 0120 เป๊ะ แต่ตัด guard ออก ใช้ WHERE true แทน) — ระวัง: อาจกิน 8+ วิ/timeout
--       จริงถ้ารันตรงๆ ผ่าน SQL editor ปกติ ให้ SET LOCAL statement_timeout = '60s' ก่อนรัน (ครีมทำผ่าน MCP เอง)
--    ข) NEW (copy CTE ก้อนใหม่ในไฟล์นี้ แทนบรรทัด guard ด้วย WHERE true) — เทียบเวลากับ ก)
--    เป้าหมาย: ข) ต้อง < 2 วินาทีสำหรับช่วง 30 วัน (headroom จาก timeout จริง 8 วิ เพราะหน้านี้ยิงหลาย RPC พร้อมกัน)

-- 3) ตรวจผลลัพธ์ตรงกันทุกแถวทุกบาท (บังคับก่อนถือว่าเสร็จ) — เทียบ baseline vs new ด้วยช่วงเดียวกัน:
--    รัน BASELINE (ก) และ NEW (ข) ทั้งคู่แบบ full SELECT (ไม่ WHERE guard) แล้ว:
-- SELECT author_id, recoveries, recovered_baht FROM (<BASELINE query>) x
-- EXCEPT
-- SELECT author_id, recoveries, recovered_baht FROM (<NEW query>) y;
-- -- expected: 0 แถว (ไม่มีส่วนต่าง) — รันสลับทิศ (NEW EXCEPT BASELINE) ด้วย ต้อง 0 แถวเช่นกัน (full diff ทั้ง 2 ทาง)
--
--    เทียบค่าที่ Pete ให้มาโดยตรง (ช่วง 2026-07-15..2026-07-21) — รัน NEW query กับช่วงนี้:
-- -- expected: คุณปุ๋ย 1 ครั้ง ฿4,996 · คุณเจน 14 ครั้ง ฿54,293 · ไม่มีสายนำ (author_id=null) 102 ครั้ง ฿327,629

-- 4) sanity: ไม่มี recovery event ของสัญญาที่เคยขยาย/ปิดก่อนกำหนด/คืนเครื่องหลุดมา (เหมือน 0120 ข้อ 5)
-- SELECT contract_id FROM public.contract_extensions
-- UNION SELECT contract_id FROM public.device_returns
-- UNION SELECT id FROM public.contracts WHERE settled_at IS NOT NULL;
-- -- เทียบกับ contract_id ที่ได้จาก NEW query ข้อ 3 — expected: ไม่ซ้ำกันเลย

-- ผลเวลาก่อน/หลังจริง (กรอกโดยครีมหลัง apply + EXPLAIN ANALYZE ผ่าน MCP แล้ว):
--   ก่อน (baseline, ช่วง 2026-06-22..2026-07-21): _____ ms  (production วัดจริงคือ timeout เกิน 8000ms / 57014)
--   หลัง (new,      ช่วง 2026-06-22..2026-07-21): _____ ms  (เป้าหมาย < 2000ms)
--   ผลลัพธ์ตรงกันทุกแถวทุกบาท (ข้อ 3 ทั้ง 2 ทิศ = 0 แถว): [ ] ยืนยันแล้ว
