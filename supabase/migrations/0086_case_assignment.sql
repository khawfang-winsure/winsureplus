-- 0086: ระบบ "จองเคส" (claim/release) — กันสองคนโทรชนกันในคิวเดียวกัน (grade เดียวกัน/admin เห็นหมด)
-- additive เท่านั้น — เพิ่มคอลัมน์ + index บน public.contracts เดิม + RPC ใหม่ 2 ตัว (SECURITY DEFINER, atomic)
-- ได้ default privileges จาก 0017 อยู่แล้ว (เพิ่มคอลัมน์ในตารางเดิมไม่ต้อง grant ใหม่)

-- ============================================================================
-- SECTION 1: คอลัมน์ assigned_to / assigned_at บน contracts
-- ============================================================================

alter table public.contracts add column if not exists assigned_to uuid references public.profiles(id);
alter table public.contracts add column if not exists assigned_at timestamptz;

comment on column public.contracts.assigned_to is 'ผู้ถือเคสอยู่ตอนนี้ (uuid ของ profiles) — null = ว่าง ใครก็ claim ได้';
comment on column public.contracts.assigned_at is 'เวลาที่ claim ล่าสุด';

create index if not exists contracts_assigned_to_idx on public.contracts (assigned_to);

-- ============================================================================
-- SECTION 2: RPC claim_case — atomic claim (กัน race: 2 คนกดพร้อมกันได้แค่คนเดียว)
-- update ...where assigned_to is null — ถ้าไม่มีแถวโดน update (มีคนถืออยู่แล้ว) raise exception
-- ============================================================================

create or replace function public.claim_case(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_updated_id uuid;
begin
  update public.contracts
     set assigned_to = auth.uid(),
         assigned_at = now()
   where id = p_contract_id
     and assigned_to is null
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'CASE_ALREADY_CLAIMED';
  end if;
end;
$$;

comment on function public.claim_case(uuid) is
  'จองเคส atomic — ตั้ง assigned_to=auth.uid() เฉพาะตอนที่ว่าง (assigned_to is null); มีคนถือแล้ว → raise CASE_ALREADY_CLAIMED';

grant execute on function public.claim_case(uuid) to authenticated;

-- ============================================================================
-- SECTION 3: RPC release_case — เจ้าของปล่อยเคสเอง หรือ admin ปล่อยแทนได้
-- update ...where assigned_to=auth.uid() or is_admin() — ถ้าไม่โดนแถว raise exception
-- ============================================================================

create or replace function public.release_case(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_updated_id uuid;
begin
  update public.contracts
     set assigned_to = null,
         assigned_at = null
   where id = p_contract_id
     and (assigned_to = auth.uid() or public.is_admin())
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'NOT_CASE_OWNER';
  end if;
end;
$$;

comment on function public.release_case(uuid) is
  'ปล่อยเคส — เจ้าของเดิม (assigned_to=auth.uid()) หรือ admin เท่านั้น; ไม่ตรง → raise NOT_CASE_OWNER';

grant execute on function public.release_case(uuid) to authenticated;

-- ============================================================================
-- SECTION 4: Smoke SQL (รันมือหลัง apply ผ่าน MCP)
-- ============================================================================
-- 1) คอลัมน์ + index มาครบ:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='contracts' and column_name in ('assigned_to','assigned_at');
--   select indexname from pg_indexes where tablename='contracts' and indexname='contracts_assigned_to_idx';
--
-- 2) RPC สร้างสำเร็จ + authenticated เรียกได้:
--   select has_function_privilege('authenticated', 'public.claim_case(uuid)', 'execute');   -- true
--   select has_function_privilege('authenticated', 'public.release_case(uuid)', 'execute'); -- true
--
-- 3) พฤติกรรม atomic (รันด้วย service_role หรือ 2 session แยก จำลอง race):
--   -- session A: select public.claim_case('<id>'); -- สำเร็จ
--   -- session B: select public.claim_case('<id>'); -- raise CASE_ALREADY_CLAIMED
