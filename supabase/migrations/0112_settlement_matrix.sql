-- 0112: seed ตารางส่วนลดปิดสัญญาก่อนกำหนดแบบใหม่ (matrix ตามชนิดสัญญา × จำนวนงวดที่จ่ายแล้ว)
-- Pete เคาะ: เดิม (0078 settlement_tiers) คิด % จากจำนวนงวดที่ "เหลือ" อย่างเดียว ไม่แยกชนิดสัญญา
-- ของใหม่แยกตาม term (3/6/9/12/15 งวด) × จำนวนงวดที่จ่ายแล้ว (paidCount) → % ส่วนลด
-- shape: {"<term>": {"<paidCount>": percent, ...}, ...}  เก็บเป็น JSON string ใน app_settings.value
-- (ตาม convention เดิมทุกประการ — column key/value/description, value เป็น text ไม่ใช่ jsonb, ดู 0078/0001)
--
-- additive ล้วน: insert...where not exists เท่านั้น ไม่มี DDL ไม่แตะตารางอื่น
-- ไม่ backfill contracts.settlement_discount ของสัญญาที่ปิดไปแล้ว
-- ไม่ลบ settlement_tiers เดิม (เก็บไว้เป็นทางถอย) — แค่ปรับ description ว่า retired

insert into public.app_settings (key, value, description)
select
  'settlement_matrix',
  '{"3":{"1":5},'
  || '"6":{"1":10,"2":12,"3":12,"4":7},'
  || '"9":{"1":10,"2":10,"3":12,"4":12,"5":12,"6":15,"7":7},'
  || '"12":{"1":10,"2":10,"3":12,"4":12,"5":12,"6":12,"7":15,"8":15,"9":15,"10":7},'
  || '"15":{"1":12,"2":12,"3":12,"4":15,"5":15,"6":15,"7":15,"8":15,"9":18,"10":18,"11":18,"12":18,"13":7}}',
  'ตารางส่วนลดปิดสัญญาก่อนกำหนด (ใหม่) — key ชั้นนอก = จำนวนงวดทั้งหมดของสัญญา (term), key ชั้นใน = จำนวนงวดที่จ่ายแล้ว (paidCount), value = % ส่วนลด'
where not exists (
  select 1 from public.app_settings where key = 'settlement_matrix'
);

-- เก็บ settlement_tiers เดิมไว้เป็นทางถอย — แค่แก้ description ว่าเลิกใช้แล้ว (ไม่ลบแถว ไม่แตะ value)
update public.app_settings
   set description = 'retired 15 ก.ค. 2026 — ใช้ settlement_matrix แทน (เก็บไว้เป็นทางถอยถ้า Pete อยากกลับไปใช้ band เดิม)'
 where key = 'settlement_tiers';

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (commented)
-- ============================================================================

-- a) seed matrix เข้าแล้ว:
-- SELECT value FROM public.app_settings WHERE key='settlement_matrix';
-- expected: JSON string ตาม seed ด้านบน

-- b) settlement_tiers ยังอยู่ครบ (ไม่ถูกลบ) แค่ description เปลี่ยน:
-- SELECT key, value, description FROM public.app_settings WHERE key='settlement_tiers';
-- expected: 1 row, value เดิม ([{"minRemaining":5,...}]), description ขึ้นต้นด้วย "retired"

-- c) service_role อ่านได้ (public.* ได้ default privileges จาก 0017 อยู่แล้ว ไม่ต้อง grant เพิ่ม):
-- SELECT has_table_privilege('service_role', 'public.app_settings', 'SELECT');
-- expected: true
