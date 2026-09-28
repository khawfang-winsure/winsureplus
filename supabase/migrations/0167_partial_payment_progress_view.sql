-- 0167: ป้าย "จ่ายบางส่วนแล้ว" — view สรุปสัญญาที่งวดค้างเก่าสุดมีเงินเข้าบางส่วนแต่ยังไม่ครบ
--       (Wave 1a: สร้าง view อย่างเดียว ยังไม่ต่อ db.ts/UI — เป็น Wave 2 แยก)
--
-- ============================================================================
-- ทำไมต้องมี view ใหม่แยก ไม่แก้ v_contract_status: v_contract_status มี 22 คอลัมน์ ผูก write-guard
-- 0149/0151/0153 + npl_as_of/npl_as_of_v2 (0159/0160) พึ่งพา CTE oldest_unpaid อยู่แล้ว ความเสี่ยงแก้ไฟล์นั้น
-- ไม่คุ้มกับแค่ต้องการป้าย UI ใหม่ 1 อัน — สร้าง view แยกที่ join CTE เดียวกันปลอดภัยกว่า
--
-- นิยาม "งวดค้างเก่าสุด" ต้อง match CTE oldest_unpaid ของ v_contract_status เป๊ะ
-- (distinct on (i.contract_id) ... order by i.contract_id, i.due_date asc, where i.paid_at is null)
-- ไม่งั้นตัวเลขบนป้ายกับยอดค้างที่โชว์คู่กันในหน้าเว็บจะอ้างคนละงวด — เช็คแล้วว่า 0148/0163 ไม่ได้แก้ query
-- นี้เลย ใช้สูตรเดิมจาก 0011/0031 ได้ตรงตัว
--
-- security_invoker = on (บังคับ ตาม 0018 pattern เดียวกับ v_contract_status): ถ้าลืม freelancer ที่ถูก
-- scope ด้วย grade (0018) + assigned_to (0099) จะเห็นข้อมูลสัญญานอกขอบเขตตัวเอง = ข้อมูลรั่ว
--
-- last_paid_at ต้อง fallback จาก installment_id → contract_id เพราะ payment_log.installment_id เป็น
-- "on delete set null" (0011) — ปรับแผน/ขยายงวด (Feature B, 0013/0014/0018) ลบ installment เดิมทิ้งแล้ว
-- log เก่าจะลอย (installment_id=null) ตรวจข้อมูลจริงแล้วพบ 14/60 เคสอยู่ในสภาพนี้ ทุกเคส fallback ไป
-- contract_id ได้คำตอบถูกต้อง (สัญญานั้นเงียบมาหลายเดือนจริง ไม่ใช่ log ของงวดอื่นที่จ่ายแล้ว) — ใช้ LATERAL
-- ประเมินเฉพาะแถวที่ผ่าน filter ของ view แล้ว (ไม่ group by ทั้งตาราง payment_log ซึ่งจะแพงและไม่จำเป็น)
-- index รองรับ: payment_log_installment_idx (0011) + payment_log_contract_idx (0011) มีอยู่แล้วทั้งคู่
-- ============================================================================

create or replace view public.v_partial_payment_progress
  with (security_invoker = on) as
select
  oldest_unpaid.contract_id,
  oldest_unpaid.installment_id,
  oldest_unpaid.installment_no,
  oldest_unpaid.due_date,
  oldest_unpaid.amount,
  oldest_unpaid.paid_amount,
  (
    coalesce(
      (
        select max(pl.created_at)
        from public.payment_log pl
        where pl.installment_id = oldest_unpaid.installment_id
          and pl.action = 'pay'
      ),
      (
        select max(pl2.created_at)
        from public.payment_log pl2
        where pl2.contract_id = oldest_unpaid.contract_id
          and pl2.action = 'pay'
      )
    ) at time zone 'Asia/Bangkok'
  ) as last_paid_at
from (
  select distinct on (i.contract_id)
    i.contract_id,
    i.id     as installment_id,
    i.installment_no,
    i.due_date,
    i.amount,
    i.paid_amount
  from public.installments i
  where i.paid_at is null
  order by i.contract_id, i.due_date asc
) oldest_unpaid
join public.contracts c
  on c.id = oldest_unpaid.contract_id
 and c.status in ('active', 'returned')
where coalesce(oldest_unpaid.paid_amount, 0) > 0
  and coalesce(oldest_unpaid.paid_amount, 0) < oldest_unpaid.amount
  and oldest_unpaid.amount > 0;

grant select on public.v_partial_payment_progress to authenticated;
grant select on public.v_partial_payment_progress to service_role;

comment on view public.v_partial_payment_progress is
  '(0167) 1 แถวต่อสัญญา เฉพาะสัญญาที่งวดค้างเก่าสุด (นิยามเดียวกับ CTE oldest_unpaid ของ v_contract_status)
   มีเงินจ่ายมาแล้วบางส่วนแต่ยังไม่ครบ (paid_amount > 0 และ < amount) กรองเฉพาะ status active/returned
   (สัญญาปิดแล้วยังมีงวดค้างบางส่วนได้จาก early-close 0131 ที่คงตารางงวดไว้ — ไม่นับ) last_paid_at fallback
   installment_id → contract_id เพราะ payment_log.installment_id on delete set null (0011); security_invoker
   บังคับตาม RLS scope ของ 0018/0099 — ห้ามถอดออก; view นี้ไม่กรอง days_late เอง ปล่อยให้ pure function
   ฝั่งเว็บกรองต่อ';

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply (ห้ามข้าม)
-- ============================================================================

-- 0) security_invoker ติดจริง (เช็คก่อนอย่างอื่นทั้งหมด — ถ้าไม่ติด = ข้อมูลรั่วข้าม scope):
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_partial_payment_progress';
--   ต้องเห็น {security_invoker=on} ใน reloptions

-- 1) grant ครบ:
-- SELECT has_table_privilege('authenticated', 'public.v_partial_payment_progress', 'SELECT'); -- true
-- SELECT has_table_privilege('service_role',  'public.v_partial_payment_progress', 'SELECT'); -- true

-- 2) จำนวนแถวรวม ต้อง = 60 (วัดจาก prod 28 ก.ย. 2026):
-- SELECT count(*) FROM public.v_partial_payment_progress;

-- 3) แบ่งตาม last_paid_at เทียบ baseline (>=14 วัน = 25, เก่ากว่า = 35 รวม fallback 14 เคส):
-- SELECT
--   count(*) FILTER (WHERE last_paid_at >= now() - interval '14 days') AS within_14d,
--   count(*) FILTER (WHERE last_paid_at <  now() - interval '14 days' OR last_paid_at IS NULL) AS older
-- FROM public.v_partial_payment_progress;

-- 4) ห้ามมี last_paid_at เป็น null เลยสักแถว (ถ้ามี = fallback พลาด ต้องสืบก่อน apply จริงกับหน้าเว็บ):
-- SELECT contract_id, installment_id FROM public.v_partial_payment_progress WHERE last_paid_at IS NULL;
--   expected: 0 rows

-- 5) งวดที่เลือกต้องตรงกับ oldest_unpaid ของ v_contract_status ทุกสัญญา (กันอ้างคนละงวด):
-- SELECT p.contract_id, p.due_date AS partial_due, vcs.next_due AS vcs_next_due
--   FROM public.v_partial_payment_progress p
--   JOIN public.v_contract_status vcs ON vcs.contract_id = p.contract_id
--   WHERE p.due_date IS DISTINCT FROM vcs.next_due;
--   expected: 0 rows

-- 6) สัญญาที่ status ไม่ใช่ active/returned ต้องไม่ติด view (early-close 0131 เคส):
-- SELECT p.contract_id FROM public.v_partial_payment_progress p
--   JOIN public.contracts c ON c.id = p.contract_id
--   WHERE c.status NOT IN ('active','returned');
--   expected: 0 rows

-- 7) สมอลค์ 2 เคสตัวอย่างจากคุณเตย (เช็คค่า + last_paid_at ให้ตรงที่คาด):
-- SELECT c.contract_no, c.customer_name, p.paid_amount, p.amount, p.last_paid_at,
--        current_date - p.due_date AS days_late_check
--   FROM public.v_partial_payment_progress p
--   JOIN public.contracts c ON c.id = p.contract_id
--   WHERE c.contract_no IN ('S00018PNQ032', 'S00018PNQ423');
--   -- S00018PNQ032 (ศิรินันท์ อุ่มสาพล): 3,600/6,343 ล่าช้า 171 วัน (fallback contract_id)
--   -- S00018PNQ423 (ปัทมา ปาพันธ์): 2,000/6,259 last_paid_at = 28 ก.ย. 2026

-- 8) ทดสอบ RLS จริงด้วย freelancer session (set_config หรือ login จริง) ก่อนปล่อย Wave 2 ขึ้น UI:
--    ต้องเห็นเฉพาะสัญญาที่อยู่ใน scope grade/assigned_to ของตัวเอง ไม่เห็นสัญญาคนอื่น
