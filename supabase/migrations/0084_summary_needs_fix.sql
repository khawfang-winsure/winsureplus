-- 0084: เพิ่มสถานะ "ถูกตีกลับจากบัญชี ต้องแก้" บนสัญญา (โชว์เป็นป้ายที่หน้า waiting-summary)
-- additive เท่านั้น — เพิ่มคอลัมน์ nullable บน public.contracts ที่มีอยู่แล้ว
-- ได้ default privileges จาก 0017 อยู่แล้ว (เพิ่มคอลัมน์ในตารางเดิมไม่ต้อง grant ใหม่)

alter table public.contracts add column if not exists needs_fix_reason text;
alter table public.contracts add column if not exists needs_fix_detail text;
alter table public.contracts add column if not exists needs_fix_by text;
alter table public.contracts add column if not exists needs_fix_at timestamptz;

comment on column public.contracts.needs_fix_reason is
  'เหตุผลที่บัญชีตีกลับ: docs_incorrect/price_incorrect/duplicate/missing_info/other — null = ไม่มีปัญหาค้าง';
comment on column public.contracts.needs_fix_detail is 'รายละเอียด/หมายเหตุประกอบ needs_fix_reason (ข้อความอิสระ)';
comment on column public.contracts.needs_fix_by is 'ชื่อคนตีกลับ (snapshot ข้อความ ไม่ผูก FK — ตาม pattern summary_shop_sent_by)';
comment on column public.contracts.needs_fix_at is 'เวลาที่ตีกลับ';

-- Smoke SQL (รันมือหลัง apply ผ่าน MCP):
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='contracts' and column_name like 'needs_fix_%';
-- expected: 4 แถว
