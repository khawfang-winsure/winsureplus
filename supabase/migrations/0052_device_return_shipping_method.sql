-- 0052: รองรับการคืนเครื่อง 2 แบบ (ส่งพัสดุ/คืนที่ร้าน) + สถานะ in_transit ระหว่างจัดส่ง

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์ใหม่บน device_returns
-- ============================================================================

alter table public.device_returns
  add column if not exists courier        text,        -- ชื่อขนส่ง (EMS, Kerry ฯลฯ) nullable
  add column if not exists return_method  text,        -- 'shipped' | 'walk_in' | null
  add column if not exists return_location text;       -- รหัส/สถานที่คืน (walk_in เท่านั้น)

-- ============================================================================
-- SECTION 2: เพิ่มค่า in_transit ใน CHECK constraint ของ device_status
--
-- 0027 สร้าง constraint แบบไม่ตั้งชื่อ → Postgres อาจตั้งชื่ออัตโนมัติ
-- เราจึงหาชื่อจริงจาก pg_constraint ก่อน แล้ว DROP + ADD (named)
-- การ DROP constraint ไม่กระทบ DEFAULT 'pending_check' (default เก็บอยู่ต่างหากใน pg_attrdef)
-- ============================================================================

do $$
declare
  v_conname text;
begin
  -- หาชื่อ constraint ที่คุม device_status บน device_returns
  select conname
    into v_conname
    from pg_constraint
   where conrelid = 'public.device_returns'::regclass
     and contype  = 'c'
     and pg_get_constraintdef(oid) ilike '%device_status%'
   limit 1;

  -- ถ้ายังมี constraint อยู่ ให้ DROP ก่อน
  if v_conname is not null then
    execute format('alter table public.device_returns drop constraint %I', v_conname);
  end if;

  -- ADD constraint ใหม่ (named) ที่มีครบ 7 ค่า รวม in_transit
  alter table public.device_returns
    add constraint device_returns_device_status_check
    check (device_status in (
      'pending_check',
      'checked',
      'pending_sale',
      'priced',
      'transferred',
      'shipped',
      'in_transit'
    ));
end $$;

-- ============================================================================
-- SECTION 3: Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- 3a) 3 คอลัมน์ใหม่มีครบ:
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name = 'device_returns'
--    AND column_name IN ('courier', 'return_method', 'return_location');
-- expected: 3 rows, data_type=text, is_nullable=YES

-- 3b) constraint ใหม่มีครบ 7 ค่า:
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.device_returns'::regclass
--    AND contype  = 'c'
--    AND pg_get_constraintdef(oid) ilike '%device_status%';
-- expected: device_returns_device_status_check มี in_transit ด้วย

-- 3c) DEFAULT ยังคงเป็น pending_check (ไม่เปลี่ยน):
-- SELECT column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name   = 'device_returns'
--    AND column_name  = 'device_status';
-- expected: 'pending_check'::text

-- 3d) ทดสอบ constraint ยอมรับ in_transit ด้วย BEGIN...ROLLBACK (ไม่ทิ้งแถวจริง):
-- BEGIN;
--   INSERT INTO public.device_returns (contract_id, case_no, device_status)
--     VALUES (<uuid สัญญาที่มีอยู่>, 1, 'in_transit');
-- ROLLBACK;
-- expected: INSERT ไม่ error (constraint ผ่าน)

-- 3e) service_role ยังมีสิทธิ์ SELECT (จาก 0017 ALTER DEFAULT PRIVILEGES):
-- SELECT has_table_privilege('service_role', 'public.device_returns', 'SELECT');
-- expected: true
