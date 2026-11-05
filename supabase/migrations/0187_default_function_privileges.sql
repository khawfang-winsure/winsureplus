-- 0187: ฟังก์ชันที่สร้างใหม่โดย postgres ไม่ให้สิทธิ์เรียกกับคนไม่ล็อกอิน (anon/PUBLIC) อัตโนมัติอีก
-- Additive: แก้เฉพาะ default privileges ของฟังก์ชัน "ที่จะสร้างต่อจากนี้" ไม่แตะฟังก์ชัน/ตาราง/ข้อมูลเดิม
-- ผล: ฟังก์ชันใหม่ใน public ได้ EXECUTE เฉพาะ postgres(owner) + authenticated (default เดิมของ schema) + service_role (เพิ่มในไฟล์นี้)
-- ผู้เขียนฟังก์ชันใหม่ที่เว็บเรียก ต้องเช็คบทบาท (admin/staff) ในเนื้อฟังก์ชันเอง; ถ้าตั้งใจเปิดให้ anon ต้อง `grant execute ... to anon` เอง
-- หมายเหตุ: ถอนแบบ global (ทุก schema ที่ postgres สร้างฟังก์ชัน) ถ้าสร้างฟังก์ชันใน schema อื่นต้อง grant เอง
-- ถ้าอนาคต `create extension` โดย postgres ลง schema อื่น (เช่น extensions) ฟังก์ชันของ extension จะไม่มี PUBLIC execute ต้อง grant execute ให้ role ที่ต้องใช้เอง

alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
