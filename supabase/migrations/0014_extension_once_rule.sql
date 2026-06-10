-- ============================================================================
-- 0014 — กฎ "ขยายระยะเวลา/เปลี่ยนวันที่ ทำได้สิทธิ์ละครั้งเดียวต่อสัญญา"
-- วิธีใช้: ก๊อปไฟล์นี้ทั้งหมด ไปวางใน Supabase Dashboard > SQL Editor > Run
-- รันซ้ำได้ปลอดภัย (idempotent — แค่ CREATE OR REPLACE ฟังก์ชันเดิม)
--
-- กฎ (ยืนยันกับ Pete):
--   - มี 2 สิทธิ์: "เปลี่ยนวันที่ชำระ" และ "ขยายจำนวนงวด" — แต่ละสิทธิ์ใช้ได้ครั้งเดียว
--   - ext_type 'due_day' ใช้สิทธิ์ "วันที่" · 'months' ใช้สิทธิ์ "งวด" · 'both' ใช้ทั้งสอง
--   - เคยเปลี่ยนวันที่แล้ว → ครั้งหน้าได้แค่ขยายงวด / เคยขยายงวดแล้ว → ครั้งหน้าได้แค่เปลี่ยนวันที่
--   - เคยทำ 'both' (หรือใช้ครบทั้งสองสิทธิ์แล้ว) → ทำอะไรไม่ได้อีก
-- (บังคับซ้ำที่ฝั่งฐานข้อมูลเพื่อกันการเลี่ยงผ่าน UI)
-- ============================================================================

create or replace function public.restructure_contract(
  p_contract_id uuid,
  p_ext_type text,
  p_new_due_day int,
  p_new_term int,
  p_new_finance numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_c           contracts%rowtype;
  v_last_paid   int;
  v_monthly     numeric;
  v_base        date;
  v_due         date;
  i             int;
  v_used_date   boolean;
  v_used_months boolean;
begin
  -- ตรวจอินพุต
  if p_ext_type not in ('due_day', 'months', 'both') then
    raise exception 'ประเภทการขยายไม่ถูกต้อง';
  end if;
  if p_new_due_day is null or p_new_due_day < 1 or p_new_due_day > 31 then
    raise exception 'วันที่ชำระต้องอยู่ระหว่าง 1–31';
  end if;
  if p_new_term is null or p_new_term <= 0 then
    raise exception 'จำนวนงวดต้องมากกว่า 0';
  end if;
  if p_new_finance is null or p_new_finance < 0 then
    raise exception 'ยอดจัดไฟแนนซ์ไม่ถูกต้อง';
  end if;

  select * into v_c from contracts where id = p_contract_id for update;
  if not found then raise exception 'ไม่พบสัญญานี้'; end if;

  -- ===== กฎสิทธิ์ครั้งเดียว: เช็คจากประวัติการขยายที่ผ่านมา =====
  select
    coalesce(bool_or(ext_type in ('due_day', 'both')), false),
    coalesce(bool_or(ext_type in ('months', 'both')), false)
    into v_used_date, v_used_months
    from contract_extensions where contract_id = p_contract_id;

  if p_ext_type = 'both' and (v_used_date or v_used_months) then
    raise exception 'สัญญานี้เคยขยาย/เปลี่ยนวันที่ไปแล้ว ทำพร้อมกันทั้งคู่ไม่ได้';
  end if;
  if p_ext_type = 'due_day' and v_used_date then
    raise exception 'สัญญานี้เปลี่ยนวันที่ชำระไปแล้ว (เปลี่ยนได้ครั้งเดียว)';
  end if;
  if p_ext_type = 'months' and v_used_months then
    raise exception 'สัญญานี้ขยายระยะเวลาไปแล้ว (ขยายได้ครั้งเดียว)';
  end if;

  -- เลขงวดที่จ่ายล่าสุด (สมมติจ่ายเรียงงวด) — ถ้าไม่เคยจ่าย = 0
  select coalesce(max(installment_no), 0) into v_last_paid
    from installments where contract_id = p_contract_id and paid_at is not null;

  v_monthly := round(p_new_finance / p_new_term);

  -- ลบงวดที่ยังไม่จ่ายทั้งหมด (ยุบรวมเข้ายอดใหม่แล้ว)
  delete from installments where contract_id = p_contract_id and paid_at is null;

  -- สร้างงวดใหม่: งวด i ครบกำหนดเดือน (เดือนปัจจุบัน + i) → งวดแรก = เดือนหน้า
  for i in 1..p_new_term loop
    v_base := (date_trunc('month', current_date) + make_interval(months => i))::date;
    v_due  := due_date_for(
      extract(year from v_base)::int,
      extract(month from v_base)::int,
      p_new_due_day
    );
    insert into installments (contract_id, installment_no, due_date, amount, status)
    values (
      p_contract_id,
      v_last_paid + i,
      v_due,
      v_monthly,
      case when v_due < current_date then 'late' else 'pending' end
    );
  end loop;

  -- บันทึกประวัติ (snapshot เก่า → ใหม่) ก่อนทับค่าในสัญญา
  insert into public.contract_extensions (
    contract_id, ext_type,
    old_due_day, new_due_day,
    old_term, new_term,
    old_finance, new_finance,
    old_monthly, new_monthly,
    new_installments, note
  ) values (
    p_contract_id, p_ext_type,
    v_c.due_day, p_new_due_day,
    v_c.term_months, v_last_paid + p_new_term,
    v_c.finance_amount, p_new_finance,
    v_c.monthly_payment, v_monthly,
    p_new_term, p_note
  );

  -- อัปเดตสัญญา: วันชำระ/ค่างวด/ยอดจัดไฟแนนซ์/จำนวนงวดรวมใหม่
  update contracts set
    due_day = p_new_due_day,
    monthly_payment = v_monthly,
    finance_amount = p_new_finance,
    term_months = v_last_paid + p_new_term
    where id = p_contract_id;
end;
$$;
