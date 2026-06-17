-- 0015_imei_national_id.sql
-- เพิ่มช่องเก็บ "หมายเลข IMEI" ของเครื่อง และ "เลขบัตรประชาชน" ของลูกค้า
-- ทั้งคู่เป็น text ปล่อยว่างได้ (nullable) — สัญญาเก่าจะว่างจนกว่าจะกรอกย้อนหลัง
-- เลขบัตรประชาชนเป็นข้อมูลอ่อนไหว (PII) → ในหน้าลิสต์แสดงแบบปิดบางส่วน (โชว์ 4 ตัวท้าย)

alter table contracts add column if not exists imei text;
alter table contracts add column if not exists national_id text;

comment on column contracts.imei is 'หมายเลข IMEI ของเครื่อง';
comment on column contracts.national_id is 'เลขบัตรประชาชนลูกค้า (PII)';
