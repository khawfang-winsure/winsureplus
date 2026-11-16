-- 0189: ขยายระยะเวลา - งวดแรกใหม่อยู่เดือนนี้ถ้าวันครบกำหนดใหม่ (หลัง clamp ปลายเดือน) มากกว่าวันนี้ (เวลาไทย) ไม่งั้นเดือนหน้า เหมือนเดิม
-- เปลี่ยนเฉพาะการคำนวณวันครบกำหนดงวดใหม่ ส่วนอื่นของ restructure_contract เหมือนเดิมทุกอย่าง

-- helper: วันครบกำหนดของงวดใหม่ลำดับที่ p_i (เริ่ม 1) รับ "วันนี้" เป็นพารามิเตอร์เพื่อทดสอบได้
create or replace function public.restructure_due_date(p_today date, p_due_day integer, p_i integer)
returns date language sql immutable set search_path to 'public', 'pg_catalog'
as $$
  select public.due_date_for(extract(year from b)::int, extract(month from b)::int, p_due_day)
  from (
    select (date_trunc('month', p_today)
      + make_interval(months =>
          (case when public.due_date_for(extract(year from p_today)::int, extract(month from p_today)::int, p_due_day) > p_today
                then 0 else 1 end) + p_i - 1))::date as b
  ) s
$$;

revoke execute on function public.restructure_due_date(date, integer, integer) from public, anon;
grant execute on function public.restructure_due_date(date, integer, integer) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restructure_contract(p_contract_id uuid, p_ext_type text, p_new_due_day integer, p_new_term integer, p_new_finance numeric, p_note text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  c public.contracts%rowtype; before_state jsonb; eid uuid; last_paid int; monthly numeric; due_date_new date; i int;
  today_th date := (now() at time zone 'Asia/Bangkok')::date;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and active=true and role in ('admin','staff')) then
    raise exception 'ไม่มีสิทธิ์ขยายระยะเวลา' using errcode='42501';
  end if;
  if p_ext_type is null or p_ext_type not in ('due_day','months','both')
    or p_new_due_day is null or p_new_due_day not between 1 and 31
    or p_new_term is null or p_new_term not between 1 and 120
    or p_new_finance is null or p_new_finance<0 or p_new_finance::text in ('NaN','Infinity','-Infinity') then
    raise exception 'กรุณาตรวจวันที่ จำนวนงวด และยอดใหม่';
  end if;
  select * into c from public.contracts where id=p_contract_id for update;
  if not found then raise exception 'ไม่พบสัญญานี้'; end if;
  if c.status<>'active' or c.settled_at is not null then raise exception 'ขยายได้เฉพาะสัญญาที่ยังผ่อนอยู่'; end if;
  if exists(select 1 from public.contract_extensions where contract_id=p_contract_id and reversed_at is null
     and ((p_ext_type in ('due_day','both') and ext_type in ('due_day','both'))
       or (p_ext_type in ('months','both') and ext_type in ('months','both')))) then
    raise exception 'สัญญานี้ใช้สิทธิ์ขยายประเภทที่เลือกแล้ว';
  end if;
  if not exists(select 1 from public.installments where contract_id=p_contract_id and paid_at is null) then
    raise exception 'สัญญานี้ผ่อนหมดแล้ว ไม่ต้องขยายระยะเวลา';
  end if;
  if exists(select 1 from public.installments where contract_id=p_contract_id and paid_at is null and paid_amount>0) then
    raise exception 'กรุณาตรวจยอดที่ชำระบางส่วนก่อนขยายระยะเวลา';
  end if;
  if exists(select 1 from public.installments i where i.contract_id=p_contract_id and i.paid_at is null
       and (coalesce(i.settled,false) or exists(select 1 from public.payment_log l where l.installment_id=i.id
         and (l.amount>0 or l.paid_amount_after>0 or coalesce(l.penalty_paid_amount,0)>0)))) then
    raise exception 'งวดที่ยังเปิดมีประวัติรับเงินหรือค่าปรับ กรุณาให้แอดมินตรวจสอบก่อนขยาย';
  end if;
  before_state:=public.extension_contract_state(p_contract_id);
  select coalesce(max(installment_no),0) into last_paid from public.installments where contract_id=p_contract_id and paid_at is not null;
  monthly:=round(p_new_finance/p_new_term);
  delete from public.installments where contract_id=p_contract_id and paid_at is null;
  for i in 1..p_new_term loop
    due_date_new:=public.restructure_due_date(today_th,p_new_due_day,i);
    insert into public.installments(contract_id,installment_no,due_date,amount,status)
      values(p_contract_id,last_paid+i,due_date_new,monthly,'pending');
  end loop;
  insert into public.contract_extensions(contract_id,ext_type,old_due_day,new_due_day,old_term,new_term,
    old_finance,new_finance,old_monthly,new_monthly,new_installments,note)
    values(p_contract_id,p_ext_type,c.due_day,p_new_due_day,c.term_months,last_paid+p_new_term,
      c.finance_amount,p_new_finance,c.monthly_payment,monthly,p_new_term,p_note) returning id into eid;
  update public.contracts set due_day=p_new_due_day,monthly_payment=monthly,
    finance_amount=p_new_finance,term_months=last_paid+p_new_term where id=p_contract_id;
  insert into public.contract_extension_snapshots(extension_id,contract_id,before_state,after_state,after_version)
    select eid,p_contract_id,before_state,public.extension_contract_state(p_contract_id),version
      from public.contract_extension_versions where contract_id=p_contract_id;
end $function$;
