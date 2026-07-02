-- 0085: แยก "ยืนยันย้อนหลัง ไม่ต้องมีสลิป" ออกจาก "รอแนบสลิป" บน shop_transfer (0083)
-- additive เท่านั้น — เพิ่มคอลัมน์ boolean not null default false บนตารางที่มี RLS/grant ครบจาก 0083 อยู่แล้ว
-- (ตารางเดิม ผ่าน RLS admin+accounting เดิม + default privileges จาก 0017 — ไม่ต้องแก้ policy)

alter table public.shop_transfer add column if not exists slip_waived boolean not null default false;

comment on column public.shop_transfer.slip_waived is
  'true = ยืนยันย้อนหลังโดยไม่มีสลิป (accounting/admin เลือกเอง) — false = ปกติ ต้องแนบสลิปก่อนถือว่าโอนสมบูรณ์';

-- หมายเหตุ: backfill ข้อมูลจริงของแถวเก่า (ถ้ามี) ครีมรันเองทีหลังผ่าน SQL แยก — migration นี้แค่การันตีคอลัมน์

-- Smoke SQL (รันมือหลัง apply ผ่าน MCP):
-- select column_name, data_type, is_nullable, column_default from information_schema.columns
--  where table_schema='public' and table_name='shop_transfer' and column_name='slip_waived';
-- expected: 1 แถว, data_type=boolean, is_nullable=NO, column_default=false
