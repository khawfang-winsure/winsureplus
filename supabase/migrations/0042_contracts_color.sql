-- 0042: เพิ่ม column color ใน contracts (สีเครื่อง standardize ตาม Apple official)
alter table public.contracts add column if not exists color text;
