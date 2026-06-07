-- ============================================================================
-- ข้อมูลตัวอย่างเริ่มต้น (ไม่บังคับ) — ก๊อปไปวางใน SQL Editor หลังรัน 0001_init.sql
-- ใส่ร้านค้า + ตัวเลือก dropdown ชุดเริ่มต้น เพื่อให้เริ่มใช้งานได้ทันที
-- ============================================================================

-- ร้านค้า
insert into shops (code, name, bank, account_no, account_name) values
  ('AQ S00016', 'ร้านมาดามศิโมบาย', 'ธนาคารกสิกร', '2302882749', 'บจก มาดามศิ อินเตอร์กรุ๊ป'),
  ('AQ S00017', 'ร้านซีเดย์โฟน', 'ธนาคาร ธกส', '20036139987', 'วิทยา ธิพงษ์สันต์');

-- รุ่นโทรศัพท์
insert into options (kind, label, sort_order) values
  ('phone_model', 'iPhone 13', 1),
  ('phone_model', 'iPhone 13 Pro Max', 2),
  ('phone_model', 'iPhone 14', 3),
  ('phone_model', 'iPhone 14 Pro', 4),
  ('phone_model', 'iPhone 14 Pro Max', 5),
  ('phone_model', 'iPhone 15 Plus', 6),
  ('phone_model', 'iPhone 16 Pro', 7);

-- ความจำ
insert into options (kind, label, sort_order) values
  ('storage', '128 GB', 1),
  ('storage', '256 GB', 2),
  ('storage', '512 GB', 3);

-- อาชีพ
insert into options (kind, label, sort_order) values
  ('occupation', 'พนักงานประจำ', 1),
  ('occupation', 'ค้าขาย', 2),
  ('occupation', 'รับจ้าง', 3),
  ('occupation', 'เกษตรกร', 4);

-- หลักฐานอาชีพ
insert into options (kind, label, sort_order) values
  ('occupation_proof', 'สลิปเงินเดือน', 1),
  ('occupation_proof', 'บัตรประชาชน', 2),
  ('occupation_proof', 'รูปถ่ายกิจการ', 3);

-- โปรโมชั่น
insert into options (kind, label, detail, sort_order) values
  ('promotion', 'ฟรีเคส+ฟิล์ม', 'แถมเคสและฟิล์มกันรอย', 1),
  ('promotion', 'ดาวน์ 0 เดือนแรก', 'ผ่อนเดือนแรกเริ่มเดือนถัดไป', 2);
