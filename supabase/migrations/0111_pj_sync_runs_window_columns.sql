-- 0111: เพิ่มคอลัมน์สังเกตการณ์ให้ pj_sync_runs รองรับ pj-sync แบบดึงย้อนหลังหลายวัน (deep-scan)
-- บริบท: pj-sync (Edge Function) เพิ่มความสามารถดึง receipts ย้อนหลังหลายวัน (days_back/start_date+
-- end_date) แก้บั๊ก "คีย์ย้อนหลังใน PJ" ที่เงินตกหล่นเงียบ (ดู comment หัวไฟล์ supabase/functions/pj-sync/index.ts)
-- คอลัมน์ใหม่ 4 ตัวนี้ใช้บันทึกว่ารอบนั้นดึงช่วงวันไหน/กี่หน้า/ตัดกลางทางเพราะเวลาหมดหรือเปล่า — เพื่อ
-- ให้ debug/smoke-test เห็นได้ตรงจาก pj_sync_runs โดยไม่ต้องงมใน error_detail (ซึ่งกรอง credential ไว้
-- ห้ามใส่รายละเอียดอยู่แล้ว)
--
-- additive ล้วน (add column if not exists, มี default ทั้งหมด) — ไม่กระทบแถวเดิม ไม่กระทบ jobid 6
-- (15 นาที, ดึงวันเดียว) เพราะโค้ดยังเขียนค่าเข้าคอลัมน์เหล่านี้เสมอไม่ว่าจะ deep-scan หรือไม่
--
-- ตารางอยู่ใน public.* ได้ default privileges อัตโนมัติจาก 0005 (authenticated) + 0017 (service_role)
-- อยู่แล้ว (ตารางเดิม ไม่ใช่ตารางใหม่) — ไม่ต้อง grant เพิ่ม

alter table public.pj_sync_runs
  add column if not exists window_start_date date,          -- start_date ที่ส่งไป PJ (แปลง ISO แล้ว) — เท่ากับ window_end_date ถ้าเป็นรอบวันเดียวปกติ
  add column if not exists window_end_date   date,           -- end_date ที่ส่งไป PJ (แปลง ISO แล้ว)
  add column if not exists pages_fetched     int default 1,  -- จำนวนหน้า pagination ที่ดึงจริง (ปกติ = 1 สำหรับรอบวันเดียว)
  add column if not exists truncated         boolean not null default false; -- true = ตัดกลางทางเพราะเกินงบเวลาประมวลผล (รอบถัดไปจับต่อเอง — ดู comment ใน index.ts)

comment on column public.pj_sync_runs.window_start_date is 'ช่วงวันที่เริ่มดึง receipts จาก PJ ของรอบนี้ (ISO) — ปกติ = window_end_date เว้นแต่เป็น deep-scan (days_back)';
comment on column public.pj_sync_runs.window_end_date is 'ช่วงวันที่สิ้นสุดดึง receipts จาก PJ ของรอบนี้ (ISO)';
comment on column public.pj_sync_runs.pages_fetched is 'จำนวนหน้า pagination (length=500/หน้า) ที่ดึงจริงจาก PJ ในรอบนี้';
comment on column public.pj_sync_runs.truncated is 'true = รอบนี้ประมวลผลไม่ครบเพราะเกินงบเวลา (PROCESSING_TIME_BUDGET_MS) — ที่เหลือรอรอบถัดไปจับต่อ (window คาบเกี่ยวกันเสมอ ไม่มีข้อมูลหาย แค่ช้า)';

-- ============================================================================
-- Verify (รันหลัง apply):
-- ============================================================================
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_schema='public' and table_name='pj_sync_runs'
--    and column_name in ('window_start_date','window_end_date','pages_fetched','truncated');
-- -- expected: 4 แถว ตรงชื่อ/ชนิดข้างบน
-- select has_table_privilege('service_role', 'public.pj_sync_runs', 'UPDATE'); -- ต้อง true (Edge Function เขียนคอลัมน์ใหม่)
