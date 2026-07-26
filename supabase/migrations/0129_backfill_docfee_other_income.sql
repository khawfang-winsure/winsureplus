-- 0129: ย้ายค่าเอกสารเดิมของสัญญาที่มีอยู่แล้ว (contracts.doc_fee > 0) เข้า other_income
--   เป็น "รายได้ค่าเอกสาร" แถวจริง (category='ค่าเอกสาร') — Wave 3 ของฟีเจอร์แยกค่าเอกสาร
--   Wave 1+2 (execDashboard.ts) มี guard buildDocFeeMovedSet() อ่าน other_income.category='ค่าเอกสาร'
--   อยู่แล้ว รอ backfill นี้ลงไปก็จะกันชนสลับอัตโนมัติ ไม่นับ docFee ซ้ำจาก contract
--
-- ขอบเขต: ทุกสัญญาที่ doc_fee > 0 ทุกสถานะ (รวม closed/returned — Pete ยืนยันย้ายทั้งหมด)
-- ยอดตั้งต้นที่ยืนยันไว้ก่อน apply: 2,408 สัญญา รวม 240,800 บาท

-- ============================================================================
-- SECTION 1: Backfill INSERT — idempotent (WHERE NOT EXISTS กันรันซ้ำ)
-- ============================================================================

insert into public.other_income (
  contract_id,
  amount,
  category,
  note,
  received_at,
  recorded_by,
  fee_kind
)
select
  c.id,
  c.doc_fee,
  'ค่าเอกสาร',
  'backfill-docfee-2026-07-23',
  c.transaction_date,
  'ระบบ (ย้ายค่าเอกสาร)',
  null
from public.contracts c
where c.doc_fee > 0
  and not exists (
    select 1 from public.other_income o
    where o.contract_id = c.id
      and o.category = 'ค่าเอกสาร'
  );

-- ============================================================================
-- SECTION 2: ห้ามแตะ — คงไว้เป็น source ของสูตรเดิม
-- ============================================================================
-- ไม่แก้ contracts.doc_fee (ยังเป็น source ของสูตร net_transfer generated column)
-- ไม่แก้สูตร/ฟังก์ชันใดๆ ใน execDashboard.ts / db.ts
-- ไม่สร้าง/ลบคอลัมน์

-- ============================================================================
-- SECTION 3: หมายเหตุ Cream — อ่านก่อน apply
-- ============================================================================

-- (ก) UNDO (ถ้าต้องย้อน — ลบเฉพาะแถวที่ backfill นี้สร้าง ด้วย note marker):
--   delete from public.other_income
--   where category = 'ค่าเอกสาร'
--     and note = 'backfill-docfee-2026-07-23';

-- (ข) VERIFY G2 (คาดหวัง count=2408, sum=240800.00 — เทียบกับยอดที่ Pete ยืนยันไว้ก่อน apply):
--   select count(*), sum(amount)
--   from public.other_income
--   where category = 'ค่าเอกสาร';

-- (ค) RE-RUN CHECK (รัน migration นี้ซ้ำต้อง insert 0 แถว — WHERE NOT EXISTS กันไว้แล้ว):
--   -- apply ซ้ำแล้วรัน (ข) อีกครั้ง ต้องได้ count/sum เท่าเดิมเป๊ะ

-- (ง) ⚠️ Cream: backup ก่อน apply จริง (pg_dump ตาราง other_income + contracts หรือ point-in-time
--     ผ่าน Supabase dashboard) เพราะเป็น bulk insert ~2,408 แถวทีเดียว ถ้าตัวเลขไม่ตรง (ข) ต้อง undo ด้วย (ก) ทันที
--     แล้วเช็คว่า execDashboard.ts guard (buildDocFeeMovedSet, บรรทัด ~223/233) ยังอ่าน category='ค่าเอกสาร'
--     ตรงเป๊ะกับ column/ค่าที่ backfill นี้เขียน — ไม่งั้นยอดรายได้จะเพี้ยน (นับซ้ำหรือหายไปเลย)
