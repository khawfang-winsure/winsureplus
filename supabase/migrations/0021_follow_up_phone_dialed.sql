-- 0021: บันทึกเบอร์โทรที่ฟรีแลนซ์กดหมุนต่อ follow_up แต่ละครั้ง (หลัก/สำรอง/พิมพ์เอง)

alter table public.follow_ups
  add column if not exists phone_dialed text;

-- nullable (ไม่บังคับ) — เก็บ verbatim text ไม่ใช่ enum
-- เพื่อรองรับกรณีที่พิมพ์เบอร์เองซึ่งไม่ตรงกับ phone/phone_alt1/phone_alt2
-- RLS: follow_ups_read + follow_ups_insert ใน 0018 ครอบ column ใหม่อัตโนมัติ
--      (column-level access ถูกกำหนดโดย row policy — ไม่ต้องเพิ่ม policy ใหม่)

-- ============================================================================
-- Smoke (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================
-- SELECT has_column_privilege('authenticated', 'public.follow_ups', 'phone_dialed', 'SELECT');
--   expected: true
-- SELECT has_column_privilege('service_role', 'public.follow_ups', 'phone_dialed', 'INSERT');
--   expected: true
