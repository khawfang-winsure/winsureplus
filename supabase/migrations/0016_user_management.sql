-- ===== 0016: User management — เพิ่ม active flag + policy ให้ admin จัดการ profiles ได้ =====
-- เป้าหมาย: รองรับหน้า /settings/users ที่ admin สร้าง/แก้/ปิดใช้งาน user ได้
-- (รหัสผ่าน + การสร้าง user ใหม่ทำผ่าน Edge Function 'admin-users' ที่ใช้ service_role)

-- เพิ่มคอลัมน์ active (พนักงานพักงาน/ออกแล้ว = active=false จะล็อกอินไม่ได้)
alter table profiles add column if not exists active boolean not null default true;

-- กันคนปิด admin ของตัวเอง (ป้องกันถูกล็อกออกจากระบบ)
create or replace function prevent_self_deactivation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.active = true and new.active = false and new.id = auth.uid() then
    raise exception 'ไม่สามารถปิดบัญชีของตัวเองได้ (ให้แอดมินคนอื่นปิดให้)';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_deactivation on profiles;
create trigger trg_prevent_self_deactivation
  before update on profiles
  for each row execute function prevent_self_deactivation();

comment on column profiles.active is 'ผู้ใช้งานสถานะใช้งานอยู่ (false = ปิด, ยังคงประวัติไว้)';
