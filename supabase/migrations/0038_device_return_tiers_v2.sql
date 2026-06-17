-- 0038: เปลี่ยน model ค่าคอมคืนเครื่องฟรีแลนซ์ จาก % ราคา → บาท/เครื่อง ตามจำนวน

-- ลบ key เก่า (idempotent — ไม่ error ถ้าไม่มี)
delete from public.app_settings where key in ('device_return_commission_rate', 'device_return_commission_tiers');

-- ใส่ key ใหม่ default 3 tier ตาม Pete: [0:0, 10:100, 20:200]
insert into public.app_settings (key, value, description)
values (
  'device_return_tiers_v2',
  '[{"minDevices":0,"bahtPerDevice":0},{"minDevices":10,"bahtPerDevice":100},{"minDevices":20,"bahtPerDevice":200}]',
  'ขั้นบรรไดค่าคอมฟรีแลนซ์คืนเครื่อง (บาท/เครื่อง retroactive รายเดือน นับทุก status)'
)
on conflict (key) do nothing;

-- smoke comments (run manual หลัง apply):
-- SELECT value FROM app_settings WHERE key = 'device_return_tiers_v2';
-- expected: 3 tier JSON array
