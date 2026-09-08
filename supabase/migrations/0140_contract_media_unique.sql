-- 0140: กันไฟล์ซ้ำเป๊ะในสัญญาเดียวกัน/ช่องเดียวกัน (unique index ระดับฐานข้อมูล ไม่พึ่งฝั่งเว็บอย่างเดียว)
-- ปัญหา: ก่อนหน้านี้เช็คไฟล์ซ้ำ (sha256) ทำแค่ฝั่งเว็บก่อนอัป — ถ้ากดซ้ำเร็วๆ/เน็ตช้าแล้วกดซ้ำ อาจลงซ้ำได้จริง
-- ตาราง contract_media ยังไม่มี column ที่ unique ครอบ (contract_id, slot_key, sha256) เมื่อยังไม่ถูกลบ (deleted_at is null)
-- ทำ partial unique index (เฉพาะแถวที่ยังไม่ soft-delete) ให้ Postgres ปฏิเสธการ insert ซ้ำเอง (error code 23505)
-- ฝั่ง db.ts (uploadMedia) ต้องจับ error 23505 แล้วลบไฟล์ที่เพิ่งอัปออกจาก storage (best effort) ก่อน throw ข้อความให้ผู้ใช้

create unique index if not exists contract_media_unique_live
  on public.contract_media (contract_id, slot_key, sha256)
  where deleted_at is null;
