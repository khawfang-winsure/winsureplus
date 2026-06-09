-- ============================================================================
-- 0007 — บันทึกว่า "ใครเป็นผู้บันทึกสัญญา" (สำหรับคิดค่าคอมมิชชั่นในอนาคต)
-- วิธีใช้: ก๊อปไฟล์นี้ทั้งหมด ไปวางใน Supabase Dashboard > SQL Editor > Run
-- รันซ้ำได้ปลอดภัย (idempotent)
--
-- หลักการ: ให้ "ฐานข้อมูลเป็นคนประทับตราเอง" ตอนสร้างสัญญา ผ่าน trigger
--   - recorded_by      = auth.uid() ของคนที่ล็อกอินอยู่ (พนักงานปลอมไม่ได้)
--   - recorded_by_name = ชื่อ ณ ตอนบันทึก (snapshot) เผื่อพนักงานลาออก/เปลี่ยนชื่อ
-- ใช้ trigger ตัวเดียวตั้งค่าทั้งสองคอลัมน์ (ไม่พึ่ง column default) เพื่อตัดความกำกวม
-- ============================================================================

alter table public.contracts
  add column if not exists recorded_by uuid references public.profiles (id),
  add column if not exists recorded_by_name text;

-- ตั้งค่าผู้บันทึกอัตโนมัติตอน INSERT เท่านั้น (แก้สัญญาทีหลังจะไม่ทับของเดิม)
create or replace function public.set_contract_recorder()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.recorded_by is null then
    new.recorded_by := auth.uid();
  end if;
  if new.recorded_by_name is null then
    new.recorded_by_name := (
      select coalesce(full_name, '') from public.profiles where id = new.recorded_by
    );
  end if;
  return new;
end;
$$;

drop trigger if exists contracts_set_recorder on public.contracts;
create trigger contracts_set_recorder
  before insert on public.contracts
  for each row execute function public.set_contract_recorder();
