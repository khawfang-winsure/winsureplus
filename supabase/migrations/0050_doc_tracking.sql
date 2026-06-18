-- 0050: เพิ่มติดตามเอกสารตัวจริง + กล่องโทรศัพท์คืนจากร้าน (รองรับ Wave 1 ฟีเจอร์ doc tracking)
-- Pete เคาะ 19 มิ.ย. 2026 — has_phone_box default false (พนักงานเลือกเอง)

-- ============================================================================
-- SECTION 1: เพิ่ม 7 columns บนตาราง contracts
-- ============================================================================

-- 1a) เอกสารตัวจริง — flag + audit
alter table public.contracts
  add column if not exists original_docs_received    boolean    not null default false,
  add column if not exists original_docs_received_at timestamptz,
  add column if not exists original_docs_received_by text;

-- 1b) กล่องโทรศัพท์ — has_phone_box (เจ้าของสัญญาเลือกเอง) + flag + audit
alter table public.contracts
  add column if not exists has_phone_box             boolean    not null default false,
  add column if not exists phone_box_received        boolean    not null default false,
  add column if not exists phone_box_received_at     timestamptz,
  add column if not exists phone_box_received_by     text;

-- ============================================================================
-- SECTION 2: Backfill สัญญาเก่า
-- ============================================================================
-- สัญญาที่มีอยู่ก่อน apply นี้ → ถือว่ารับเอกสารแล้ว (ไม่ต้องติดตาม)
-- ⚠️  now() ใน WHERE = timestamp ณ ตอน apply; สัญญาทุกอันก่อน apply จะ original_docs_received=true
-- ⚠️  original_docs_received_at คง null ตั้งใจ — ไม่มีวันจริง; metric เฉลี่ยวันค้างจะ skip null
-- ⚠️  has_phone_box คง false (default) สำหรับสัญญาเก่า — พนักงานเลือกเอง
update public.contracts
  set original_docs_received = true
  where created_at < now();

-- ============================================================================
-- SECTION 3: Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- 3a) 7 columns ใหม่มีครบ + ชนิด/nullability ถูก:
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'contracts'
--     AND column_name IN (
--       'original_docs_received', 'original_docs_received_at', 'original_docs_received_by',
--       'has_phone_box', 'phone_box_received', 'phone_box_received_at', 'phone_box_received_by'
--     )
--   ORDER BY column_name;
-- expected: 7 rows
--   original_docs_received    boolean   NO  false
--   original_docs_received_at timestamptz YES (null)
--   original_docs_received_by text       YES (null)
--   has_phone_box             boolean   NO  false
--   phone_box_received        boolean   NO  false
--   phone_box_received_at     timestamptz YES (null)
--   phone_box_received_by     text       YES (null)

-- 3b) backfill count — ต้องเห็นเป็นจำนวนสัญญาที่มีก่อน apply (ควร > 0):
-- SELECT count(*) FROM public.contracts WHERE original_docs_received = true;
-- expected: จำนวนสัญญาเก่าทั้งหมด (ก่อน apply) — ห้าม 0

-- 3c) สัญญาใหม่ที่สร้างหลัง apply ต้อง original_docs_received = false (default):
-- เช็คด้วย created_at > (timestamp ตอน apply) แต่ในทางปฏิบัติ Cream verify ด้วย
-- SELECT count(*) FROM public.contracts WHERE original_docs_received = false;
-- expected: ≥ 0 (จะเพิ่มขึ้นเมื่อมีสัญญาใหม่ถ้า Staff ยังไม่ยืนยัน)

-- 3d) service_role ยัง access contracts ได้ (ไม่กระทบจาก alter add column):
-- SELECT has_table_privilege('service_role', 'public.contracts', 'SELECT');
-- expected: true (จาก 0017 ALTER DEFAULT PRIVILEGES)
