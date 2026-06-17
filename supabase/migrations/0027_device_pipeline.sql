-- 0027: เพิ่ม Device Pipeline workflow columns ให้ device_returns (สถานะเครื่อง + พัสดุ + ราคาขาย)

alter table public.device_returns
  add column if not exists tracking_number text,
  add column if not exists device_status text
    check (device_status in (
      'pending_check',
      'checked',
      'pending_sale',
      'priced',
      'transferred',
      'shipped'
    )) default 'pending_check',
  add column if not exists sale_price numeric,
  add column if not exists priced_at timestamptz,
  add column if not exists transferred_at timestamptz,
  add column if not exists shipped_at timestamptz,
  add column if not exists device_status_updated_at timestamptz default now(),
  add column if not exists device_status_by text;

-- backfill: case_no=3 = ลูกค้าคืน+ขายแล้วเสร็จสิ้น → shipped
-- rows อื่น ๆ ใช้ default 'pending_check' จาก column definition ด้านบน
update public.device_returns
   set device_status = 'shipped'
 where case_no = 3
   and device_status = 'pending_check';
