-- ============================================================================
-- แก้สำคัญ: ให้สิทธิ์ระดับตาราง (GRANT) แก่ role authenticated
-- ก๊อปไปวางใน SQL Editor (รันได้แม้รัน 0001-0004 ไปแล้ว — แก้อาการ 403 permission denied)
-- เหตุ: เปิด RLS + มี policy แล้ว แต่ role authenticated ยังไม่มีสิทธิ์ "เข้าถึงตาราง"
-- ============================================================================

grant usage on schema public to authenticated, anon;

-- ผู้ใช้ที่ล็อกอินแล้ว: อ่าน/เขียนได้ (RLS เป็นตัวคุมว่าใครทำอะไรได้จริง)
grant select, insert, update, delete on all tables in schema public to authenticated;

-- view สถานะ (authenticated ต้องอ่านได้)
grant select on v_contract_status, v_daily_transfer_summary to authenticated;

-- ฟังก์ชัน rpc (เช่น ยืนยันชำระงวด)
grant execute on all functions in schema public to authenticated;

-- ตาราง/ฟังก์ชันที่จะสร้างเพิ่มในอนาคต ให้ได้สิทธิ์เดียวกันอัตโนมัติ
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;
