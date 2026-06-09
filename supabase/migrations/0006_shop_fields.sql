-- 0006_shop_fields.sql
-- เพิ่มฟิลด์ข้อมูลติดต่อให้ตารางร้านค้า (เผื่อต่อยอดอนาคต)
-- รันใน Supabase: SQL Editor > วางทั้งหมด > Run
-- ปลอดภัย: ใช้ IF NOT EXISTS รันซ้ำได้ ไม่กระทบข้อมูลเดิม

alter table public.shops
  add column if not exists owner_name      text,
  add column if not exists phone           text,
  add column if not exists facebook_link   text,
  add column if not exists contact_channel text,
  add column if not exists address         text,
  add column if not exists province        text;
