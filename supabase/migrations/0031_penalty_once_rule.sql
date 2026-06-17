-- 0031: กฎค่าปรับครั้งเดียวต่อสัญญา — คิดเฉพาะงวดที่ค้างเก่าสุด + เพิ่ม penalty_overridden flag

-- ============================================================================
-- SECTION 1: Snapshot backup ก่อนเปลี่ยน (safety net สำหรับ rollback)
-- ============================================================================

create table if not exists public._penalty_backup_2026_06_14 as
select id, contract_id, installment_no, due_date, penalty_amount, status, paid_amount
from public.installments;

-- ============================================================================
-- SECTION 2: Schema additive — penalty_overridden flag
-- ============================================================================

alter table public.installments
  add column if not exists penalty_overridden boolean default false;

-- ============================================================================
-- SECTION 3: run_daily_update() — rewrite penalty block ตามกฎใหม่
--
-- กฎ: คิดค่าปรับเฉพาะงวดที่ค้างเก่าสุด (min due_date) ที่ยังไม่จ่าย ต่อสัญญา
-- งวดค้างที่ไม่ใช่เก่าสุด → penalty_amount = 0, penalty_days = 0
-- ยกเว้น penalty_overridden = true (admin กำหนด override ไม่ถูก reset)
-- status='late' ยังคงตั้งสำหรับงวดค้างทุกงวด (logic เดิม)
-- Blocks 2–4 ของ 0018 คงไว้ verbatim (notifications + current_grade)
-- ============================================================================

create or replace function public.run_daily_update()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  per_day  numeric := (select value::numeric from app_settings where key = 'penalty_per_day');
  max_days int     := (select value::int    from app_settings where key = 'penalty_max_days');
begin
  -- 1a) ตั้ง status='late' สำหรับงวดที่ยังไม่จ่ายและเลยกำหนด (ทุกงวด เหมือนเดิม)
  update public.installments i
  set status = 'late'
  from public.contracts c
  where i.contract_id = c.id
    and c.status = 'active'
    and i.paid_at is null
    and i.due_date < current_date;

  -- 1b) reset penalty_amount=0 + penalty_days=0 สำหรับงวดที่ค้างแต่ไม่ใช่เก่าสุด
  --     (มีงวดอื่นใน contract เดียวกันที่ due_date เก่ากว่าและยังไม่จ่าย)
  --     ยกเว้น penalty_overridden=true (ห้าม reset งวดที่ admin override ไว้)
  update public.installments i
  set penalty_amount = 0,
      penalty_days   = 0
  from public.contracts c
  where i.contract_id = c.id
    and c.status = 'active'
    and i.paid_at is null
    and i.due_date < current_date
    and coalesce(i.penalty_overridden, false) = false
    and exists (
      select 1
      from public.installments earlier
      where earlier.contract_id = i.contract_id
        and earlier.paid_at is null
        and earlier.due_date < i.due_date
    );

  -- 1c) คิดค่าปรับสำหรับงวดที่ค้างเก่าสุด (earliest unpaid overdue per contract)
  --     = งวดที่ paid_at is null + due_date < current_date + ไม่มีงวดเก่ากว่า (ที่ยังไม่จ่าย)
  --     ยกเว้น penalty_overridden=true (ปล่อยตามที่ admin กำหนดไว้)
  update public.installments i
  set penalty_days   = least(current_date - i.due_date, max_days),
      penalty_amount = least(current_date - i.due_date, max_days) * per_day
  from public.contracts c
  where i.contract_id = c.id
    and c.status = 'active'
    and i.paid_at is null
    and i.due_date < current_date
    and coalesce(i.penalty_overridden, false) = false
    and not exists (
      select 1
      from public.installments earlier
      where earlier.contract_id = i.contract_id
        and earlier.paid_at is null
        and earlier.due_date < i.due_date
    );

  -- 2) แจ้งเตือน: ครบกำหนดชำระวันนี้ (กันซ้ำในวันเดียว)
  insert into public.notifications (contract_id, type, message)
  select i.contract_id, 'due_today', 'ครบกำหนดชำระวันนี้'
  from public.installments i
  join public.contracts c on c.id = i.contract_id
  where c.status = 'active'
    and i.paid_at is null
    and i.due_date = current_date
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = i.contract_id
        and n.type = 'due_today'
        and n.created_at::date = current_date
    );

  -- 3) แจ้งเตือน: เพิ่งเลยกำหนด (เลยมา 1 วัน)
  insert into public.notifications (contract_id, type, message)
  select i.contract_id, 'newly_late', 'เลยกำหนดชำระแล้ว'
  from public.installments i
  join public.contracts c on c.id = i.contract_id
  where c.status = 'active'
    and i.paid_at is null
    and i.due_date = current_date - 1
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = i.contract_id
        and n.type = 'newly_late'
        and n.created_at::date = current_date
    );

  -- 4) [0018] อัปเดต current_grade ในสัญญา active
  update public.contracts c
  set current_grade = grade_for_days_late(
    greatest(
      0,
      (current_date - (
        select min(i.due_date)
        from public.installments i
        where i.contract_id = c.id and i.paid_at is null
      ))::int
    )
  )
  where c.status = 'active';

end;
$$;

-- ============================================================================
-- SECTION 4: Smoke SQL (Cream รันหลัง apply + run_daily_update() ผ่าน MCP — not executed here)
-- ============================================================================

-- 4a) snapshot มี row เท่ากับ installments ก่อน run:
--   SELECT count(*) FROM public._penalty_backup_2026_06_14;
--   SELECT count(*) FROM public.installments;
--   -- expected: เท่ากัน

-- 4b) penalty_overridden column มีอยู่:
--   SELECT has_column_privilege('authenticated', 'public.installments', 'penalty_overridden', 'SELECT');
--   -- expected: true

-- 4c) หลัง run_daily_update() → ไม่มี contract ที่มี penalty_amount > 0 เกิน 1 งวด:
--   SELECT contract_id, count(*) filter (where penalty_amount > 0) as p_count
--   FROM public.installments
--   WHERE status = 'late'
--   GROUP BY contract_id
--   HAVING count(*) filter (where penalty_amount > 0) > 1;
--   -- expected: 0 rows

-- 4d) ตรวจ function มีอยู่ครบ:
--   SELECT proname, prosrc LIKE '%penalty_overridden%' as has_override_guard
--   FROM pg_proc WHERE proname = 'run_daily_update';
--   -- expected: 1 row, has_override_guard = true
