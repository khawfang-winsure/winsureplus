-- ============================================================================
-- Phase 3 — สร้างตารางงวดผ่อนอัตโนมัติเมื่อเพิ่มสัญญา
-- ก๊อปไปวางใน SQL Editor หลังรัน 0001_init.sql
-- ============================================================================

-- สร้างงวดผ่อนตามจำนวนเดือน โดยงวดที่ 1 = เดือนถัดจากวันทำรายการ
-- วันครบกำหนดใช้ due_date_for() เพื่อ clamp ปลายเดือน (31 -> 30/28)
create or replace function generate_installments()
returns trigger language plpgsql as $$
declare
  i int;
  base date;
  d date;
begin
  if new.term_months is null or new.term_months <= 0 then
    return new;
  end if;
  for i in 1..new.term_months loop
    base := (date_trunc('month', new.transaction_date) + make_interval(months => i))::date;
    d := due_date_for(
      extract(year from base)::int,
      extract(month from base)::int,
      coalesce(new.due_day, 1)
    );
    insert into installments (contract_id, installment_no, due_date, amount, status)
    values (new.id, i, d, coalesce(new.monthly_payment, 0), 'pending');
  end loop;
  return new;
end;
$$;

-- สร้างเฉพาะตอน "เพิ่มสัญญาใหม่" (ไม่ทำตอนแก้ไข เพื่อไม่ให้ประวัติการชำระหาย)
drop trigger if exists trg_generate_installments on contracts;
create trigger trg_generate_installments
  after insert on contracts
  for each row execute function generate_installments();

-- ฟังก์ชันยืนยันการชำระงวด (พนักงานกดเอง — ระบบไม่ auto ให้)
create or replace function mark_installment_paid(p_installment_id uuid)
returns void language sql as $$
  update installments
  set paid_at = now(), status = 'paid'
  where id = p_installment_id;
$$;
