-- 0063: เพิ่ม set search_path ให้ regen_installments (hardening security definer)

-- ============================================================================
-- regen_installments(p_contract_id uuid)
-- เหมือน 0062 ทุกบรรทัด เพิ่มเฉพาะ set search_path = public, pg_catalog
-- กัน search_path shadowing บน security definer (มาตรฐานเดียวกับ restructure_contract / record_payment)
-- ============================================================================
create or replace function public.regen_installments(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_transaction_date  date;
  v_due_day           int;
  v_term_months       int;
  v_monthly_payment   numeric;
  i                   int;
  v_base              date;
  v_due               date;
begin
  -- 1. lock แถวสัญญา + อ่านค่าที่ใช้สร้างงวด
  select
    transaction_date,
    due_day,
    term_months,
    monthly_payment
  into
    v_transaction_date,
    v_due_day,
    v_term_months,
    v_monthly_payment
  from contracts
  where id = p_contract_id
  for update;

  if not found then
    raise exception 'contract not found: %', p_contract_id;
  end if;

  -- 2a. guard: ห้าม regen ถ้าเคยขยายระยะเวลา/ปรับโครงสร้างแล้ว
  if exists (
    select 1 from contract_extensions where contract_id = p_contract_id
  ) then
    raise exception 'blocked_extended';
  end if;

  -- 2b. guard: ห้าม regen ถ้ามีงวดที่ชำระแล้ว (paid_at is not null)
  if exists (
    select 1 from installments
    where contract_id = p_contract_id
      and paid_at is not null
  ) then
    raise exception 'blocked_paid';
  end if;

  -- 3. ลบงวดที่ยังไม่ชำระทั้งหมด
  --    (guard ด้านบนยืนยันแล้วว่าไม่มีแถวที่ paid_at is not null)
  delete from installments
  where contract_id = p_contract_id
    and paid_at is null;

  -- 4. สร้างงวดใหม่
  --    base = วันที่ 1 ของเดือน (transaction_date) + i เดือน
  --    ใช้ due_date_for() (จาก 0001) เพื่อ clamp ปลายเดือน
  for i in 1..v_term_months loop
    v_base := (date_trunc('month', v_transaction_date) + make_interval(months => i))::date;
    v_due  := due_date_for(
      extract(year  from v_base)::int,
      extract(month from v_base)::int,
      v_due_day
    );
    insert into installments (contract_id, installment_no, due_date, amount, status)
    values (p_contract_id, i, v_due, v_monthly_payment, 'pending');
  end loop;
end;
$$;

-- re-grant กัน create or replace ลบ grant เดิม
grant execute on function public.regen_installments(uuid) to authenticated;
