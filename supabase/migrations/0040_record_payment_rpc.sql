-- 0040: แปลง recordPaymentWithPenalty เป็น RPC atomic transaction (กัน network ตายกลางทาง)

-- ============================================================================
-- SECTION 1: RPC record_payment_with_penalty — atomic INSERT+UPDATE ในก้อนเดียว
--
-- ความหมายของยอด (ตรงกับ db.ts recordPaymentWithPenalty เดิม):
--   p_paid_amount        = ค่างวด principal เท่านั้น (ไม่รวมค่าปรับ)
--   p_penalty_paid_amount = ค่าปรับที่ชำระครั้งนี้
--   payment_log.amount   = p_paid_amount + p_penalty_paid_amount (ยอดรับจริง)
--   installments.paid_amount = สะสม principal เท่านั้น (ใช้คำนวณ outstanding)
--
-- Trigger ที่ยังทำงานผ่าน RPC นี้:
--   - set_payment_log_actor  (BEFORE INSERT ON payment_log) — ประทับ acted_by + by_name
--   - trg_clear_promise_on_pay (AFTER INSERT ON payment_log) — ล้าง promise เมื่อ action='pay'
-- ============================================================================

create or replace function public.record_payment_with_penalty(
  p_installment_id      uuid,
  p_paid_amount         numeric,          -- principal เท่านั้น
  p_paid_at             timestamptz,      -- เวลาชำระ (ส่งจาก client ตอนกดยืนยัน)
  p_by_name             text,
  p_penalty_paid_amount numeric default 0 -- ค่าปรับที่ชำระ (default 0 = ไม่มีค่าปรับ)
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_contract_id         uuid;
  v_installment_amount  numeric;
  v_prev_paid           numeric;
  v_new_principal_total numeric;
  v_total_received      numeric;
  v_fully_paid          boolean;
begin
  -- ล็อก row เพื่อกัน concurrent payment บนงวดเดียวกัน
  select contract_id, amount, coalesce(paid_amount, 0)
    into v_contract_id, v_installment_amount, v_prev_paid
    from public.installments
   where id = p_installment_id
     for update;

  if not found then
    raise exception 'installment % not found', p_installment_id;
  end if;

  -- paid_amount สะสมเฉพาะ principal (สอดคล้องกับ outstanding formula)
  v_new_principal_total := v_prev_paid + p_paid_amount;
  -- amount ใน payment_log = ยอดรับจริง (principal + penalty)
  v_total_received      := p_paid_amount + p_penalty_paid_amount;
  -- ปิดงวดเมื่อ principal สะสม >= ค่างวด (ตรงกับ record_payment RPC ใน 0011)
  v_fully_paid          := v_new_principal_total >= v_installment_amount
                           and v_installment_amount > 0;

  -- INSERT payment_log ก่อน — trigger set_payment_log_actor + trg_clear_promise_on_pay จะ fire
  insert into public.payment_log (
    installment_id,
    contract_id,
    action,
    amount,               -- ยอดรับจริง (principal + penalty)
    paid_amount_after,    -- principal สะสม หลังทำรายการ
    penalty_paid_amount,
    by_name
  ) values (
    p_installment_id,
    v_contract_id,
    'pay',
    v_total_received,
    v_new_principal_total,
    p_penalty_paid_amount,
    p_by_name
  );

  -- UPDATE installments — paid_amount สะสม principal เท่านั้น
  if v_fully_paid then
    update public.installments
       set paid_amount   = v_new_principal_total,
           paid_at       = p_paid_at,
           status        = 'paid',
           paid_by_name  = p_by_name
     where id = p_installment_id;
  else
    update public.installments
       set paid_amount   = v_new_principal_total,
           paid_at       = null,
           status        = case when due_date < current_date then 'late' else 'pending' end,
           paid_by_name  = null
     where id = p_installment_id;
  end if;

end;
$$;

-- GRANT: authenticated (พนักงาน) + service_role (Edge Function) เรียกได้
grant execute on function public.record_payment_with_penalty(uuid, numeric, timestamptz, text, numeric)
  to authenticated, service_role;
