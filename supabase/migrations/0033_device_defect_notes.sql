-- 0033: เพิ่มช่องบันทึกข้อบกพร่องอุปกรณ์ (device_defect_notes) ใน device_returns

alter table public.device_returns
  add column if not exists device_defect_notes text;
