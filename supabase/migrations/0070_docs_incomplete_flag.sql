-- 0070: ธง "รับเอกสารแล้ว แต่ไม่ครบ/ต้องแก้ไข" บนตาราง contracts
-- เคสยังถือว่ารับเอกสารแล้ว (ไม่กระทบ original_docs_received / isDocComplete) แค่ติดธงเตือน
--   + จดว่าขาดเอกสารชนิดไหนบ้าง (array ของคีย์: contract / consent / receipt)
-- additive + idempotent (add column if not exists) — ไม่ backfill, default privileges จาก 0017 ครอบอยู่แล้ว

-- ============================================================================
-- SECTION 1: เพิ่ม 4 columns บนตาราง contracts
-- ============================================================================

alter table public.contracts
  add column if not exists docs_incomplete       boolean     not null default false,
  add column if not exists docs_incomplete_items jsonb       not null default '[]'::jsonb,
  add column if not exists docs_incomplete_at    timestamptz,
  add column if not exists docs_incomplete_by    text;

-- ============================================================================
-- SECTION 2: Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- 2a) 4 columns ใหม่มีครบ + ชนิด/nullability ถูก:
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'contracts'
--     AND column_name IN (
--       'docs_incomplete', 'docs_incomplete_items', 'docs_incomplete_at', 'docs_incomplete_by'
--     )
--   ORDER BY column_name;
-- expected: 4 rows
--   docs_incomplete       boolean     NO  false
--   docs_incomplete_at    timestamptz YES (null)
--   docs_incomplete_by    text        YES (null)
--   docs_incomplete_items jsonb       NO  '[]'::jsonb

-- 2b) service_role ยัง access contracts ได้ (ไม่กระทบจาก alter add column):
-- SELECT has_table_privilege('service_role', 'public.contracts', 'SELECT');
-- expected: true (จาก 0017 ALTER DEFAULT PRIVILEGES)
