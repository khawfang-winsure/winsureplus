-- 0079: RPC record_payment_spread — ตัดยอดชำระกระจายหลายงวดตามลำดับ (additive, ไม่แตะตาราง/คอลัมน์เดิม)
-- public.* ได้ default privileges จาก 0017 อยู่แล้ว — function ใหม่ยังต้องอาศัย GRANT execute แยก

-- ============================================================================
-- SECTION 1: RPC record_payment_spread
--
-- ใช้เมื่อยอดชำระ 1 ครั้ง (p_principal) ครอบคลุมมากกว่า 1 งวด
-- (เช่น กล่องรอตรวจ PJ ที่ลูกค้าโอนยอดรวม 2-3 งวดคราวเดียว)
--
-- Logic การตัด:
--   วนงวด unpaid (paid_at is null) เรียง installment_no น้อย→มาก
--   ตัด p_principal เข้างวดทีละ gap (= amount − paid_amount) จนหมด
--   ค่าปรับ (p_penalty) ใส่แค่งวดแรกที่ตัดเท่านั้น
--   ถ้าตัดครบทุก unpaid แล้วยังเหลือเศษ → บวกทับงวด unpaid ตัวท้ายที่เพิ่งตัด
--   (ให้ตรง client paymentSpread.ts; กรณีไม่มีงวด unpaid เลย → fallback งวดสุดท้ายของสัญญา)
--
-- ความหมายของยอด (สอดคล้องกับ 0040 record_payment_with_penalty):
--   p_principal               = เงินต้นค่างวดรวม (ไม่รวมค่าปรับ)
--   p_penalty                 = ค่าปรับ (ใส่ payment_log งวดแรกเท่านั้น)
--   payment_log.amount        = take + pen (ยอดรับจริงต่อแถว)
--   installments.paid_amount  = สะสม principal เท่านั้น
--
-- Trigger ที่ยังทำงานผ่าน RPC นี้:
--   - set_payment_log_actor     (BEFORE INSERT ON payment_log)
--   - trg_clear_promise_on_pay  (AFTER INSERT ON payment_log)
-- ============================================================================

create or replace function public.record_payment_spread(
  p_contract_id  uuid,
  p_principal    numeric,     -- เงินต้นรวมที่ชำระ (ไม่รวมค่าปรับ)
  p_penalty      numeric,     -- ค่าปรับทั้งก้อน (ใส่งวดแรกที่ตัด)
  p_paid_at      timestamptz, -- เวลาชำระ (UTC midnight ลงท้าย Z เสมอ)
  p_by_name      text         -- ชื่อผู้บันทึก
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rem      numeric;   -- ยอดคงเหลือที่ยังต้องตัด
  v_first    boolean;   -- flag: งวดแรกที่ตัด (ใส่ค่าปรับที่นี่)
  -- ตัวแปร loop
  rec        record;    -- (id, amount, paid)
  gap        numeric;   -- ช่องว่างของงวด = amount − paid
  take       numeric;   -- ที่ตัดจริงจากงวดนี้ = least(gap, v_rem)
  pen        numeric;   -- ค่าปรับที่ใส่งวดนี้ (เฉพาะงวดแรก)
  new_paid   numeric;   -- paid_amount หลังตัด
  fully      boolean;   -- ปิดงวดสำเร็จหรือเปล่า
  -- ตัวแปรสำหรับ overpay
  v_last_id        uuid;
  v_last_paid      numeric;
  v_last_touched   uuid := null;  -- งวด unpaid ตัวท้ายที่ loop เพิ่งตัด (เป้าใส่เศษ ให้ตรง client paymentSpread.ts)
  v_last_touched_paid numeric;
begin
  v_rem   := p_principal;
  v_first := true;

  -- วนงวดที่ยังไม่จ่าย (paid_at is null) เรียงตาม installment_no
  for rec in
    select id,
           amount,
           coalesce(paid_amount, 0) as paid
      from public.installments
     where contract_id = p_contract_id
       and paid_at is null
     order by installment_no
  loop
    gap  := rec.amount - rec.paid;
    take := least(gap, v_rem);

    -- ข้ามงวดที่ไม่มีช่องว่าง (จ่ายเต็มแต่ paid_at ยังไม่เซ็ต — edge case)
    continue when take <= 0;

    pen      := case when v_first then p_penalty else 0 end;
    new_paid := rec.paid + take;
    fully    := new_paid >= rec.amount and rec.amount > 0;

    -- INSERT payment_log — trigger set_payment_log_actor + trg_clear_promise_on_pay จะ fire
    insert into public.payment_log (
      installment_id,
      contract_id,
      action,
      amount,               -- ยอดรับจริง (take + pen)
      paid_amount_after,    -- principal สะสมหลังทำรายการ
      penalty_paid_amount,
      by_name
    ) values (
      rec.id,
      p_contract_id,
      'pay',
      take + pen,
      new_paid,
      pen,
      p_by_name
    );

    -- UPDATE installments
    update public.installments
       set paid_amount  = new_paid,
           paid_at      = case when fully then p_paid_at else null end,
           status       = case
                            when fully then 'paid'
                            else (case when due_date < current_date then 'late' else 'pending' end)
                          end,
           paid_by_name = case when fully then p_by_name else null end
     where id = rec.id;

    v_last_touched := rec.id;   -- เก็บงวดล่าสุดที่ตัด (เศษเกินจะลงงวดนี้ ให้ตรง client)
    v_rem   := v_rem - take;
    v_first := false;

    exit when v_rem <= 0;
  end loop;

  -- ถ้ายังมีเศษ → บวกทับ "งวด unpaid ตัวท้ายที่ loop เพิ่งตัด" (v_last_touched)
  -- ให้ตรงกับ client paymentSpread.ts ที่เอาเศษลงงวด unpaid สุดท้ายที่ตัด
  -- กรณี defensive (ไม่มีงวด unpaid ถูกตัดเลย) → fallback งวดสุดท้ายของสัญญา (installment_no มากสุด)
  if v_rem > 0 then
    if v_last_touched is not null then
      -- เป้า = งวดล่าสุดที่ตัดใน loop (ปิดไปแล้ว คงสถานะ paid — ไม่แตะ paid_at/status)
      select coalesce(paid_amount, 0)
        into v_last_touched_paid
        from public.installments
       where id = v_last_touched;

      insert into public.payment_log (
        installment_id,
        contract_id,
        action,
        amount,
        paid_amount_after,
        penalty_paid_amount,
        by_name
      ) values (
        v_last_touched,
        p_contract_id,
        'pay',
        v_rem,
        v_last_touched_paid + v_rem,
        0,
        p_by_name
      );

      -- UPDATE paid_amount เท่านั้น — ไม่แตะ paid_at/status (งวดนี้ปิดใน loop แล้ว คงสถานะ paid)
      update public.installments
         set paid_amount = paid_amount + v_rem
       where id = v_last_touched;

    else
      -- defensive: ไม่มีงวด unpaid ถูกตัดเลย → คงพฤติกรรมเดิม (งวดสุดท้ายของสัญญา)
      select id, coalesce(paid_amount, 0)
        into v_last_id, v_last_paid
        from public.installments
       where contract_id = p_contract_id
       order by installment_no desc
       limit 1;

      if found then
        insert into public.payment_log (
          installment_id,
          contract_id,
          action,
          amount,
          paid_amount_after,
          penalty_paid_amount,
          by_name
        ) values (
          v_last_id,
          p_contract_id,
          'pay',
          v_rem,
          v_last_paid + v_rem,
          0,
          p_by_name
        );

        -- UPDATE paid_amount เท่านั้น — ไม่แตะ paid_at/status
        update public.installments
           set paid_amount = paid_amount + v_rem
         where id = v_last_id;
      end if;
    end if;
  end if;

end;
$$;

-- GRANT: authenticated (พนักงาน) + service_role (Edge Function) เรียกได้
grant execute on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text)
  to authenticated, service_role;

comment on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text) is
  'ตัดยอดชำระกระจายหลายงวดตามลำดับ installment_no — ค่าปรับใส่งวดแรกเท่านั้น; เศษที่เกินบวกทับงวด unpaid ตัวท้ายที่เพิ่งตัด (ตรง client paymentSpread.ts) fallback งวดสุดท้ายถ้าไม่มีงวด unpaid';

-- Verify (commented out — ครีม/ติ๊กรันหลัง apply):
-- select pg_get_functiondef('public.record_payment_spread(uuid,numeric,numeric,timestamptz,text)'::regprocedure);
-- select has_function_privilege('service_role', 'public.record_payment_spread(uuid,numeric,numeric,timestamptz,text)', 'execute');
