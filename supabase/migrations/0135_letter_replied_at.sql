-- 0135: เพิ่มวันที่ตอบกลับจดหมาย (replied_at) ให้บันทึกได้ว่าลูกค้าตอบกลับวันไหน

alter table public.collection_letters
  add column if not exists replied_at date;

comment on column public.collection_letters.replied_at is
  'วันที่ลูกค้าตอบกลับจดหมาย (กรอกเองตอนบันทึกผล reply=replied) — null ถ้า pending/no_reply หรือยังไม่ระบุวัน; ห้าม backfill ย้อนหลัง ไม่มีแหล่งวันที่จริงสำหรับแถวเก่า';

-- ไม่มี UPDATE/backfill ใดๆ — แถวเก่าที่ reply='replied' อยู่แล้ว replied_at จะเป็น null
-- (เจ้าของเคาะแล้ว: ไม่มีแหล่งวันที่จริง ห้ามสร้างข้อมูลปลอม ทีมจะกรอกเองทีหลัง)

-- RLS/grant: ใช้ policy collection_letters_all + grant to authenticated จาก 0010 อยู่แล้ว
-- คอลัมน์ใหม่ในตารางเดิมสืบทอดสิทธิ์อัตโนมัติ ไม่ต้อง grant ซ้ำ
