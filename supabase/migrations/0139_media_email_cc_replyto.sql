-- 0139: เพิ่ม setting อีเมลสำเนา (CC) + ตัวเลือกตั้ง Reply-To เป็นอีเมลพนักงานที่กดส่ง (send-company-email)
-- เป้าหมาย: ให้ตั้งอีเมลสำเนาผู้เกี่ยวข้อง + ให้บริษัทตอบกลับถึงคนดูแลเคสโดยตรง (แทนกล่องเมลกลาง GMAIL_USER)
-- Additive — app_settings ใช้ on conflict do nothing (ไม่ทับค่าที่ admin แก้เองไปแล้ว)

insert into app_settings (key, value, description) values
  ('company_email_cc', '', 'อีเมลสำเนา (CC) คั่นด้วยจุลภาค ว่าง = ไม่ส่งสำเนา'),
  ('media_email_reply_to_sender', 'false', 'true = ตั้ง Reply-To เป็นอีเมลล็อกอินของพนักงานที่กดส่ง เพื่อให้บริษัทตอบกลับถึงคนดูแลเคสโดยตรง')
on conflict (key) do nothing;

-- ============================================================================
-- Smoke SQL (รันมือหลัง apply เพื่อ verify — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================
-- 1) seed ครบ 2 key:
-- SELECT key, value, description FROM app_settings
--   WHERE key IN ('company_email_cc', 'media_email_reply_to_sender');
--
-- 2) ไม่ทับค่าเดิมถ้ามีคนตั้งไว้ก่อนแล้ว (รัน migration ซ้ำ):
-- ค่าที่ได้ต้องเหมือนเดิม ไม่กลับไปเป็น '' / 'false'
