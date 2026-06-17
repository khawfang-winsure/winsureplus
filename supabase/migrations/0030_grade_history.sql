-- 0030: เก็บประวัติการเปลี่ยนเกรดสัญญา สำหรับคำนวณ Roll Rate / Cure Rate รายเดือน

-- ============================================================================
-- SECTION 1: Table — contract_grade_history
-- เก็บทุกครั้งที่ contracts.current_grade เปลี่ยน (trigger fire)
-- ============================================================================

create table if not exists public.contract_grade_history (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null references public.contracts(id) on delete cascade,
  old_grade     text,
  new_grade     text,
  changed_at    timestamptz not null default now()
);

-- index หลัก: drill-down ตาม contract + timeline
create index if not exists contract_grade_history_contract_idx
  on public.contract_grade_history(contract_id, changed_at desc);

-- index รอง: aggregate รายเดือน (v_grade_monthly_changes scan ทั้ง table)
create index if not exists contract_grade_history_changed_at_idx
  on public.contract_grade_history(changed_at desc);

-- ============================================================================
-- SECTION 2: RLS
-- admin + staff + executive = ดูได้ (เพื่อ Roll/Cure rate calc)
-- freelancer = ดูไม่ได้ (ข้อมูล grade history ≠ scope ของ freelancer)
-- ============================================================================

alter table public.contract_grade_history enable row level security;

drop policy if exists grade_history_read on public.contract_grade_history;
create policy grade_history_read on public.contract_grade_history
  for select to authenticated
  using (
    is_admin()
    or is_executive()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
  );

-- authenticated: SELECT เท่านั้น (INSERT ผ่าน SECURITY DEFINER trigger เท่านั้น)
grant select on public.contract_grade_history to authenticated;

-- service_role: full access สำหรับ Edge Functions + cron (ครอบโดย 0017 default privileges ด้วย)
grant select, insert, update, delete on public.contract_grade_history to service_role;

-- ============================================================================
-- SECTION 3: Trigger function — log_grade_change()
-- SECURITY DEFINER: ทำงานเป็น owner ไม่ใช่ caller
--   → INSERT ผ่านได้แม้ authenticated ไม่มี INSERT policy บน table
-- set search_path = public, pg_catalog: กัน search_path injection
-- Guard: is distinct from → ไม่บันทึกถ้า grade เท่าเดิม (รวม null = null)
-- ============================================================================

create or replace function public.log_grade_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- เก็บเฉพาะเมื่อ grade จริงเปลี่ยน (รวม null↔value)
  if old.current_grade is distinct from new.current_grade then
    insert into public.contract_grade_history (contract_id, old_grade, new_grade)
    values (new.id, old.current_grade, new.current_grade);
  end if;
  return new;
end;
$$;

-- ============================================================================
-- SECTION 4: Trigger — trg_log_grade_change on contracts
-- drop if exists ก่อนสร้างใหม่ (additive-safe)
-- AFTER UPDATE OF current_grade: fire เฉพาะเมื่อ column นั้นถูก set
-- FOR EACH ROW: per-contract (run_daily_update mass-update ~2000 rows/day = 2000 trigger fires)
-- ============================================================================

drop trigger if exists trg_log_grade_change on public.contracts;
create trigger trg_log_grade_change
  after update of current_grade on public.contracts
  for each row execute function public.log_grade_change();

-- ============================================================================
-- SECTION 5: Backfill — initial snapshot ของ contracts ที่มี grade ปัจจุบัน
-- บันทึก "starting state" (old_grade = null, new_grade = current_grade) ให้ทุก contract active
-- idempotent: not exists check กัน double-insert ถ้า migration run ซ้ำ
-- NOTE: สร้าง spike "new" ใน month bucket ปัจจุบัน — ปกติ ไม่ปนกับ roll/cure buckets
-- ============================================================================

insert into public.contract_grade_history (contract_id, old_grade, new_grade, changed_at)
select
  id,
  null,
  current_grade,
  now()
from public.contracts
where current_grade is not null
  and not exists (
    select 1
    from public.contract_grade_history h
    where h.contract_id = contracts.id
  )
on conflict do nothing;

-- ============================================================================
-- SECTION 6: View — v_grade_monthly_changes
-- aggregate Roll/Cure/New/Exit count รายเดือน สำหรับ Dashboard UI ทีหลัง
--
-- security_invoker = on (CRITICAL):
--   ถ้าไม่ใส่ → view รันเป็น owner → bypass RLS บน contract_grade_history
--   → freelancer อ่าน aggregate ได้แม้ table policy บล็อก
--   ใส่ security_invoker → view รันเป็น caller → grade_history_read policy apply
--   → admin/staff/executive เห็นข้อมูล; freelancer ได้ 0 rows (ถูกต้องตาม intent)
--
-- Exit branch (grade → null) NOTE:
--   run_daily_update() update current_grade where status='active' เท่านั้น
--   ตอนนี้ไม่มี code ที่ set current_grade = null เมื่อสัญญาปิด
--   → 'exit' rows จะไม่เกิดจริงในปัจจุบัน (forward-looking branch สำหรับอนาคต)
-- ============================================================================

create or replace view public.v_grade_monthly_changes
  with (security_invoker = on)
as
with changes as (
  select
    date_trunc('month', changed_at at time zone 'Asia/Bangkok') as month_bkt,
    old_grade,
    new_grade,
    case
      -- Roll = เกรดลง (A→B/C/D/E, B→C/D/E, ...)
      when old_grade is not null
           and new_grade is not null
           and array_position(array['A','B','C','D','E'], new_grade)
             > array_position(array['A','B','C','D','E'], old_grade)
        then 'roll'
      -- Cure = เกรดขึ้น (E→D/C/B/A, ...)
      when old_grade is not null
           and new_grade is not null
           and array_position(array['A','B','C','D','E'], new_grade)
             < array_position(array['A','B','C','D','E'], old_grade)
        then 'cure'
      -- New = เข้าระบบใหม่ (null → grade) รวม backfill snapshot ด้วย
      when old_grade is null and new_grade is not null then 'new'
      -- Exit = ออกจากระบบ (grade → null = จ่ายครบ / ปิดสัญญา)
      when old_grade is not null and new_grade is null then 'exit'
      else 'same'
    end as change_type
  from public.contract_grade_history
)
select
  month_bkt,
  change_type,
  count(*) as cnt
from changes
group by month_bkt, change_type
order by month_bkt desc, change_type;

-- authenticated: SELECT (admin/staff/exec เห็นผ่าน grade_history_read; freelancer เห็น 0 rows)
grant select on public.v_grade_monthly_changes to authenticated;

-- ============================================================================
-- SECTION 7: Smoke SQL (คอมเมนต์ — รัน manual หลัง apply)
-- ============================================================================

-- 1. trigger ถูก attach:
--    SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_log_grade_change';
--    → ต้องได้ 1

-- 2. policy ถูกสร้าง:
--    SELECT count(*) FROM pg_policies WHERE tablename = 'contract_grade_history';
--    → ต้องได้ 1

-- 3. backfill สำเร็จ:
--    SELECT count(*) FROM public.contract_grade_history;
--    → ต้องได้ ≥ จำนวน contracts ที่ current_grade is not null

-- 4. service_role access:
--    SELECT has_table_privilege('service_role', 'public.contract_grade_history', 'SELECT');
--    → ต้องได้ true

-- 5. trigger fire probe (rollback-safe):
--    BEGIN;
--      UPDATE public.contracts SET current_grade = 'C'
--        WHERE id = '<test-uuid-ที่ปัจจุบัน-grade-A>'
--          AND current_grade = 'A';
--      SELECT * FROM public.contract_grade_history
--        WHERE contract_id = '<test-uuid>' ORDER BY changed_at DESC LIMIT 1;
--      -- expected: old_grade='A', new_grade='C'
--    ROLLBACK;
