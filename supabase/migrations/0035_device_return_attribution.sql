-- 0035: เพิ่ม attribution ฟรีแลนซ์ + repair_cost ใน device_returns (คอมมิชชั่นคืนเครื่อง)

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์ใหม่ใน device_returns
-- ============================================================================

alter table public.device_returns
  add column if not exists attributed_freelancer_id uuid references public.profiles(id) on delete set null,
  add column if not exists attributed_at timestamptz,
  add column if not exists repair_cost numeric(12,2) default 0;

-- ============================================================================
-- SECTION 2: Trigger — auto-attribute เมื่อ INSERT device_returns
-- หา freelancer ที่บันทึก follow_up result='returned' ล่าสุดใน 30 วัน
-- SECURITY DEFINER: ต้องอ่าน follow_ups + profiles ซึ่งมี RLS คุม — definer context ข้ามได้
-- ============================================================================

create or replace function public.attribute_device_return_to_freelancer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_freelancer_id uuid;
begin
  -- ถ้า caller ระบุ attributed_freelancer_id มาเองแล้ว → ไม่ต้องหา
  if new.attributed_freelancer_id is not null then
    new.attributed_at := coalesce(new.attributed_at, now());
    return new;
  end if;

  -- หา freelancer ที่บันทึก follow_up result='returned' ล่าสุดใน 30 วัน
  select f.author_id into v_freelancer_id
  from public.follow_ups f
  join public.profiles p on p.id = f.author_id
  where f.contract_id = new.contract_id
    and f.follow_up_result = 'returned'
    and f.created_at >= now() - interval '30 days'
    and p.role = 'freelancer'
  order by f.created_at desc
  limit 1;

  if v_freelancer_id is not null then
    new.attributed_freelancer_id := v_freelancer_id;
    new.attributed_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_attribute_device_return on public.device_returns;
create trigger trg_attribute_device_return
  before insert on public.device_returns
  for each row execute function public.attribute_device_return_to_freelancer();

-- ============================================================================
-- SECTION 3: app_settings — commission rate เริ่มต้น 5%
-- key เป็น primary key (0001) → on conflict (key) ปลอดภัย
-- ============================================================================

insert into public.app_settings (key, value, description)
values ('device_return_commission_rate', '0.05', 'อัตราค่าคอมมิชชั่นคืนเครื่องสำหรับฟรีแลนซ์ (0.05 = 5%)')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 4: Smoke queries (รัน manual หลัง apply เพื่อยืนยัน)
-- ============================================================================
-- columns exist (expected: 3):
-- SELECT count(*) FROM information_schema.columns
--   WHERE table_name='device_returns'
--   AND column_name IN ('attributed_freelancer_id','attributed_at','repair_cost');
--
-- trigger exists (expected: 1):
-- SELECT count(*) FROM pg_trigger WHERE tgname='trg_attribute_device_return';
--
-- service_role access (expected: true):
-- SELECT has_table_privilege('service_role','public.device_returns','SELECT');
