-- 0053: เพิ่ม pending_doc_items (รายการเอกสารที่รอ สำหรับ Case Online) บนสัญญา

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์ pending_doc_items บน contracts
-- NOT NULL DEFAULT '[]' เพราะสัญญาเก่าทุกอัน = ยังไม่ระบุรายการเอกสาร (list ว่าง)
-- ============================================================================

alter table public.contracts
  add column if not exists pending_doc_items jsonb not null default '[]'::jsonb;

-- ============================================================================
-- SECTION 2: Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- 2a) คอลัมน์มีอยู่ + ค่า NOT NULL + default ถูก:
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name   = 'contracts'
--    AND column_name  = 'pending_doc_items';
-- expected: jsonb, NOT NULL ('[]'::jsonb as default), is_nullable=NO

-- 2b) สัญญาเก่าทั้งหมด backfill เป็น [] อัตโนมัติจาก default (ไม่มี NULL):
-- SELECT count(*) FROM public.contracts WHERE pending_doc_items IS NULL;
-- expected: 0

-- 2c) service_role ยังมีสิทธิ์ SELECT บน contracts (จาก 0017):
-- SELECT has_table_privilege('service_role', 'public.contracts', 'SELECT');
-- expected: true

-- 2d) ทดสอบ write/read jsonb array (ใน psql หรือ REST):
-- UPDATE public.contracts
--    SET pending_doc_items = '["บัตรประชาชน","ทะเบียนบ้าน"]'::jsonb
--  WHERE id = <uuid สัญญาทดสอบ>;
-- SELECT pending_doc_items FROM public.contracts WHERE id = <uuid>;
-- expected: ["บัตรประชาชน","ทะเบียนบ้าน"]
-- (rollback หรือ restore หลังทดสอบ)
