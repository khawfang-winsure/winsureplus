-- 0165: ตัดสิทธิ์ TRUNCATE/REFERENCES/TRIGGER ของ anon+authenticated บนตาราง/view เช็คเครดิต (0164)
--
-- บริบท: ตอนตรวจ grant ของ Wave 2 (credit-check Edge Function) เจอว่า `authenticated` มีสิทธิ์
-- TRUNCATE บน public.credit_checks (และตารางอื่นอีกรวม 62 ตารางทั้งฐาน) ทั้งที่ไม่มี migration ไหนของเรา
-- (0005/0017 ฯลฯ) เคย grant TRUNCATE ให้ตรงๆ เลย — น่าจะเป็นค่าตั้งต้นระดับ schema ที่ Supabase ทำไว้ตอน
-- provision โปรเจกต์ (ก่อนมี migration history) ไม่ใช่สิ่งที่ migration ในโฟลเดอร์นี้เคยตั้งใจให้
--
-- ⚠️ ปัญหานี้เป็น "ทั้งฐาน" (62 ตาราง) — การแก้แบบครอบคลุมทุกตารางที่มีอยู่แล้วอยู่นอกขอบเขตงานนี้
-- (เสี่ยงกระทบของเดิมที่ไม่เกี่ยวกับเช็คเครดิตเลย ต้องให้คุณเตย/ติ๊กเห็นชอบแยกต่างหาก) ไฟล์นี้แก้เฉพาะ
-- 4 ตาราง + 1 view ที่เพิ่งสร้างใน 0164 เท่านั้น ตามที่ขอบเขตงาน Wave 2 นี้ระบุ
--
-- หมายเหตุ: shop_credit_pin กับ credit_check_rate_log ที่ 0164 ทำ `revoke all ... from authenticated, anon`
-- ไปแล้ว (ครอบ TRUNCATE/REFERENCES/TRIGGER อยู่แล้วในคำว่า "all") — รันซ้ำในไฟล์นี้เป็น no-op ปลอดภัย
-- ไม่กระทบอะไร (idempotent) ใส่ไว้ด้วยเพื่อความชัดเจนว่า "ครบทั้ง 4 ตาราง+view" ตามที่ระบุขอบเขตงาน
-- ส่วน credit_checks/credit_check_files ของจริงคือจุดที่ 0164 revoke แค่ insert/delete จาก authenticated
-- (ไม่ใช่ all) — TRUNCATE/REFERENCES/TRIGGER เลยยังหลงเหลืออยู่จนกว่าไฟล์นี้จะ apply
--
-- REVOKE ... ON TABLE ใช้ได้กับ view ด้วยใน Postgres (v_credit_check_queue) แม้ TRUNCATE จะไม่มีความหมาย
-- จริงกับ view (Postgres ยอมให้ grant/revoke สิทธิ์ที่ relkind นั้นใช้จริงไม่ได้ เก็บเป็น ACL เฉยๆ ไม่ error)
--
-- Additive/idempotent — REVOKE ไม่มีอยู่แต่แรกก็ไม่ error (ต่างจาก DROP) ไม่แตะ SELECT/INSERT/UPDATE/DELETE
-- หรือ policy ใดๆ ที่ 0164 ตั้งไว้แล้ว
--
-- ⚠️ ยังไม่ apply — ครีมจะเป็นคน apply ผ่าน MCP หลังทีมตรวจงาน Wave 2 นี้แล้วเท่านั้น (ตามที่สั่งงาน)

revoke truncate, references, trigger on table
  public.credit_checks,
  public.credit_check_files,
  public.shop_credit_pin,
  public.credit_check_rate_log,
  public.v_credit_check_queue
from anon, authenticated;

-- ============================================================================
-- Verify checklist สำหรับครีม (รันหลัง apply — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================

-- SELECT has_table_privilege('authenticated', 'public.credit_checks', 'TRUNCATE');       -- expected: false
-- SELECT has_table_privilege('authenticated', 'public.credit_check_files', 'TRUNCATE');  -- expected: false
-- SELECT has_table_privilege('authenticated', 'public.shop_credit_pin', 'TRUNCATE');     -- expected: false
-- SELECT has_table_privilege('authenticated', 'public.credit_check_rate_log', 'TRUNCATE'); -- expected: false
-- SELECT has_table_privilege('anon', 'public.credit_checks', 'TRUNCATE');                -- expected: false (เป็น false อยู่แล้วจาก 0164)
-- ตรวจว่า SELECT/INSERT/UPDATE/DELETE ของ authenticated บน credit_checks/credit_check_files ไม่เปลี่ยนจาก 0164:
-- SELECT has_table_privilege('authenticated', 'public.credit_checks', 'SELECT');  -- expected: true (policy คุมอีกชั้น)
-- SELECT has_table_privilege('authenticated', 'public.credit_checks', 'INSERT');  -- expected: false (0164 revoke ไว้)
