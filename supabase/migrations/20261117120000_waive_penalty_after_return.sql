-- 20261117120000: ยกค่าปรับช่วง "ลงระบบช้า" หลังคืนเครื่อง — ถ้าคีย์คืนเครื่องช้ากว่าวันคืนจริง ค่าปรับที่เดินหลังวันคืนจริงต้องไม่คิดกับลูกค้า (คุณเตยเคาะ 17 พ.ย. 2569)
-- additive: create or replace function + drop trigger if exists ก่อนสร้างใหม่ ไม่แตะข้อมูลเดิม ไม่ backfill
-- กติกา: วันคืนจริง = device_returns.created_at (เวลาไทย); คีย์เข้าระบบ = recorded_at
--   งวดที่มีค่าปรับ > 0 และไม่ใช่ค่าที่ตั้งมือ (penalty_overridden) -> ลดเหลือ min(ปัจจุบัน, ค่าปรับ ณ วันคืนจริง) แต่ไม่ต่ำกว่ายอดค่าปรับที่เก็บไปแล้ว; ไม่เคยเพิ่ม -> รันซ้ำได้ (idempotent)
--   ค่าปรับ ณ วันคืนจริง = least(greatest(0, วันคืน - due_date), penalty_max_days) * penalty_per_day (สูตรเดียวกับ run_daily_update/0116)
--   งวดที่ penalty_overridden=true (คนตั้งมือ/PJ) ไม่แตะ แต่นับและ raise notice ไว้
--   บันทึกทุกงวดที่ลดลง penalty_override_history (เหมือน 0127) เหตุผล 'ยกค่าปรับช่วงลงระบบช้า (คืนจริง dd/mm)'
-- ล็อกสัญญาก่อนงวด (ลำดับเดียวกับ 0185/0188)

create or replace function public.waive_penalty_after_return(p_return_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_contract_id uuid;
  v_created     timestamptz;
  v_asof        date;
  v_per_day     numeric;
  v_max_days    int;
  v_by_name     text;
  v_reason      text;
  v_target      numeric;
  v_paid        numeric;
  v_changed     int := 0;
  v_skipped     int := 0;
  r             record;
begin
  select contract_id, created_at into v_contract_id, v_created
    from public.device_returns where id = p_return_id;
  if v_contract_id is null then
    return 0;
  end if;

  v_asof := (v_created at time zone 'Asia/Bangkok')::date;
  v_reason := 'ยกค่าปรับช่วงลงระบบช้า (คืนจริง ' || to_char(v_asof, 'DD/MM') || ')';

  select coalesce((select value::numeric from public.app_settings where key = 'penalty_per_day'), 100) into v_per_day;
  select coalesce((select value::int from public.app_settings where key = 'penalty_max_days'), 7) into v_max_days;
  if v_per_day <= 0 then v_per_day := 100; end if;

  select full_name into v_by_name from public.profiles where id = auth.uid();
  v_by_name := coalesce(v_by_name, 'ระบบ');

  -- ล็อกสัญญาก่อนงวด (เหมือนทางลงเงิน)
  perform 1 from public.contracts where id = v_contract_id for update;

  for r in
    select i.id, i.due_date, i.penalty_amount, coalesce(i.penalty_overridden, false) as overridden
      from public.installments i
     where i.contract_id = v_contract_id
       and coalesce(i.penalty_amount, 0) > 0
     order by i.installment_no
     for update
  loop
    if r.overridden then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_target := least(greatest(0, (v_asof - r.due_date)::int), v_max_days) * v_per_day;
    v_paid   := coalesce(public.penalty_paid_for_installment(r.id), 0);
    v_target := greatest(v_target, v_paid);

    if r.penalty_amount > v_target then
      update public.installments
         set penalty_amount = v_target,
             penalty_days   = round(v_target / v_per_day)::int
       where id = r.id;

      insert into public.penalty_override_history
        (installment_id, contract_id, old_amount, new_amount, reason, by_name)
      values (r.id, v_contract_id, r.penalty_amount, v_target, v_reason, v_by_name);

      v_changed := v_changed + 1;
    end if;
  end loop;

  if v_skipped > 0 then
    raise notice 'waive_penalty_after_return: ข้าม % งวดที่ตั้งค่าปรับมือ (overridden) ของสัญญา %', v_skipped, v_contract_id;
  end if;
  return v_changed;
end;
$$;

revoke all on function public.waive_penalty_after_return(uuid) from public, anon, authenticated;
grant execute on function public.waive_penalty_after_return(uuid) to service_role;

comment on function public.waive_penalty_after_return(uuid) is
  '(20261117120000) ลดค่าปรับงวดของสัญญาที่คืนเครื่อง ให้เหลือเท่าที่ควรเป็น ณ วันคืนจริง (device_returns.created_at เวลาไทย) ไม่ต่ำกว่าที่เก็บแล้ว ไม่เพิ่ม ข้ามงวด penalty_overridden คืนจำนวนงวดที่ลด log ลง penalty_override_history; idempotent';

-- trigger: เรียกเฉพาะเมื่อวันคืนจริง (ไทย) ก่อนวันที่คีย์ (ไทย)
create or replace function public.trg_waive_penalty_after_return()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if (new.created_at at time zone 'Asia/Bangkok')::date
       < (coalesce(new.recorded_at, now()) at time zone 'Asia/Bangkok')::date then
    perform public.waive_penalty_after_return(new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.trg_waive_penalty_after_return() from public, anon, authenticated;
grant execute on function public.trg_waive_penalty_after_return() to service_role;

drop trigger if exists waive_penalty_after_return on public.device_returns;
create trigger waive_penalty_after_return
  after insert or update of created_at on public.device_returns
  for each row execute function public.trg_waive_penalty_after_return();

-- ===== test (รันใน BEGIN ... ROLLBACK เท่านั้น) =====
-- begin;
--   select installment_no, due_date, penalty_days, penalty_amount, penalty_overridden, public.penalty_paid_for_installment(id) paid
--     from installments where contract_id='112fe272-1d9d-46f5-9f1e-07239a0e435c' order by installment_no;  -- ก่อน
--   insert into device_returns (contract_id, case_no, created_at)
--     values ('112fe272-1d9d-46f5-9f1e-07239a0e435c', 1, '2026-10-31T12:00:00+07');   -- recorded_at=now() -> trigger ทำงาน
--   select installment_no, due_date, penalty_days, penalty_amount, penalty_overridden from installments
--     where contract_id='112fe272-1d9d-46f5-9f1e-07239a0e435c' order by installment_no;  -- หลัง
--   select old_amount, new_amount, reason from penalty_override_history
--     where contract_id='112fe272-1d9d-46f5-9f1e-07239a0e435c' order by created_at desc limit 5;
--   -- idempotent: ยิงซ้ำต้องได้ 0
--   select public.waive_penalty_after_return((select id from device_returns where contract_id='112fe272-1d9d-46f5-9f1e-07239a0e435c' order by recorded_at desc limit 1));
-- rollback;
