-- 0025: เพิ่มคอลัมน์บันทึกว่าใครเป็นคนส่งอีเมล/สรุปยอด (audit by-name)

alter table public.contracts
  add column if not exists email_sent_by   text,
  add column if not exists summary_sent_by text;

-- ทั้งสองคอลัมน์เก็บเป็น text (snapshot ชื่อตอนกด ไม่ใช่ FK)
-- เพื่อให้ข้อมูลคงอยู่แม้ผู้ส่งถูกลบบัญชีในภายหลัง
-- ค่าที่ส่งมาคือ useAuth().name (full_name) จาก profile ของผู้ใช้
