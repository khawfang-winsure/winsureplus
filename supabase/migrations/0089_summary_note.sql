-- 0089: หมายเหตุเคสติดปัญหา (summary_note) — พนักงานโน้ตเองว่าเคสนี้สรุปยอดไม่ได้เพราะติดอะไร
-- คนละระบบกับ needs_fix_* (0084 = บัญชีตีกลับ) — ห้ามชนกัน ไม่ reuse คอลัมน์เดิม
-- additive เท่านั้น — เพิ่มคอลัมน์ nullable บน public.contracts ที่มีอยู่แล้ว ได้ default privileges จาก 0017

alter table public.contracts add column if not exists summary_note text;
alter table public.contracts add column if not exists summary_note_by text;
alter table public.contracts add column if not exists summary_note_at timestamptz;

comment on column public.contracts.summary_note is
  'หมายเหตุอิสระที่พนักงานเขียนเอง: เคสนี้สรุปยอดไม่ได้เพราะติดอะไร — null/'''' = ไม่มีโน้ตค้าง (คนละระบบกับ needs_fix_* ของ 0084)';
comment on column public.contracts.summary_note_by is 'ชื่อคนเขียนโน้ต (snapshot ข้อความ ไม่ผูก FK — ตาม pattern needs_fix_by)';
comment on column public.contracts.summary_note_at is 'เวลาที่เขียน/แก้โน้ตล่าสุด';

-- ============================================================================
-- RPC set_summary_note — เขียนผ่าน RPC เท่านั้น (ไม่เปิด contracts update policy กว้างขึ้น)
-- SECURITY DEFINER + guard is_admin() OR is_staff() ภายใน — freelancer เรียกไม่ผ่าน (pattern เดียวกับ 0072)
-- byName ดึงจาก profiles ของ auth.uid() เอง ไม่เชื่อค่าที่ client ส่งมา (กัน spoof ชื่อ)
-- p_note = null หรือ '' ถือเป็น "เคลียร์โน้ต" (เซ็ต summary_note=null พร้อม by/at)
-- ============================================================================

create or replace function public.set_summary_note(
  p_contract_id uuid,
  p_note        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_note text;
  v_by   text;
begin
  -- SECURITY GUARD: freelancer/anon ห้ามเรียก RPC นี้
  if not (is_admin() or is_staff()) then
    raise exception 'permission denied: set_summary_note requires admin or staff role';
  end if;

  -- normalize: '' ถือเป็น null (เคลียร์โน้ต)
  v_note := nullif(trim(coalesce(p_note, '')), '');

  select full_name into v_by from public.profiles where id = auth.uid();

  update public.contracts
     set summary_note    = v_note,
         summary_note_by = v_by,
         summary_note_at = now()
   where id = p_contract_id;

  if not found then
    raise exception 'contract not found: %', p_contract_id;
  end if;
end;
$$;

grant execute on function public.set_summary_note(uuid, text)
  to authenticated, service_role;

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- a) คอลัมน์ครบ 3 ตัว:
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='contracts' and column_name like 'summary_note%';
-- expected: 3 แถว (summary_note, summary_note_by, summary_note_at)

-- b) RPC สร้างสำเร็จ:
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name='set_summary_note';
-- expected: 1 row

-- c) authenticated มีสิทธิ์ execute:
-- select has_function_privilege('authenticated', 'public.set_summary_note(uuid, text)', 'EXECUTE');
-- expected: true
