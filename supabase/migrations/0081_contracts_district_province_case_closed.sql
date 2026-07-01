-- 0081: เพิ่มคอลัมน์อำเภอ/จังหวัด + วันเวลา/ชื่อพนักงานปิดเคสในคิวโทร (ใน public.contracts)
-- หมายเหตุ: อยู่ใน public.* ได้ default privileges จาก 0017 โดยอัตโนมัติ ไม่ต้อง GRANT เพิ่ม

alter table public.contracts
  add column if not exists district            text,
  add column if not exists province            text,
  add column if not exists case_closed_at      timestamptz,
  add column if not exists case_closed_by      text;
