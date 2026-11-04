-- 0181: แก้ record_payment_spread ให้กระจายค่าปรับตามงวดจริง (เดิมเอาค่าปรับทั้งก้อนลงงวดเดียว ทำให้งวดถัดไปค้างผี)
--
-- ปัญหา: pj-sync รวมค่าปรับต่อวันต่อ INV เป็นก้อนเดียว (เช่น 1,400 = งวด 9 + งวด 10 อย่างละ 700) แต่ RPC (0115)
--   ลงทั้งก้อนที่งวดเก่าสุดที่มีค่าปรับค้างงวดเดียว -> งวดถัดไปไม่มีเงินค่าปรับ -> run_daily_update นับต่อถึง 700 = ค้างผี
-- แก้ (เฉพาะการลงค่าปรับ; เงินต้น/ใบเสร็จ/error เดิมทุกอย่าง) จัดสรรก่อนลง 3 ขั้น:
--   1) เรียงงวด installment_no: ลงเท่ายอดค้าง (penalty_amount - penalty_paid_for_installment) เท่าที่มี
--   2) เหลือ: ลงงวดที่ยังไม่จ่ายเงินต้น + due_date < วันชำระ เรียงเก่า->ใหม่ งวดละไม่เกินเพดานต่องวด
--      = least(per_day x max_days, per_day x จำนวนวันเลยกำหนด ณ วันจ่าย) หักที่จ่ายแล้ว+ที่จัดสรรรอบนี้
--      (งวดเลยกำหนด 3 วันรับได้ไม่เกิน 300) -- รองรับงวดถัดไปที่ run_daily_update ตั้งค่าปรับเป็น 0 ไว้
--   วันชำระ = (p_paid_at at time zone 'UTC')::date เพราะ pj-sync และ db.ts ส่งเที่ยงคืน UTC
--   3) ยังเหลือ: ลงงวดเป้าหมายเดิม (0115) ไม่ทิ้งเงิน เพราะ PJ อาจคิดเกินเพดานจริง
-- งวดที่ถูกแตะเงินต้นในรอบนี้ แนบค่าปรับในแถวเดียวกัน; งวดที่ไม่ถูกแตะเงินต้น ใช้แถวค่าปรับล้วน (ไม่แตะ paid_at/status)
-- Additive: create or replace signature เดิม

create or replace function public.record_payment_spread(
  p_contract_id    uuid,
  p_principal      numeric,
  p_penalty        numeric,
  p_paid_at        timestamptz,
  p_by_name        text,
  p_receipt_uuids  jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rem      numeric;
  v_recorded boolean := false;
  v_penalty_target_id uuid;
  v_alloc    jsonb := '{}'::jsonb;   -- installment_id(text) -> ค่าปรับที่จะลงงวดนั้น
  v_left     numeric;
  v_a        numeric;
  v_cap      numeric;
  v_cap_i    numeric;
  v_paid_date date := (p_paid_at at time zone 'UTC')::date;
  v_cur      numeric;
  v_per_day  numeric;
  v_max_days numeric;
  rec        record;
  gap        numeric;
  take       numeric;
  pen        numeric;
  new_paid   numeric;
  fully      boolean;
  v_last_id        uuid;
  v_last_paid      numeric;
  v_last_touched   uuid := null;
  v_last_touched_paid numeric;
begin
  if coalesce(p_principal, 0) < 0 or coalesce(p_penalty, 0) < 0 then
    raise exception 'ยอดติดลบไม่ถูกต้อง (เงินต้น=%, ค่าปรับ=%)', p_principal, p_penalty;
  end if;

  if coalesce(p_principal, 0) <= 0 and coalesce(p_penalty, 0) <= 0 then
    raise exception 'ไม่มียอดให้บันทึก (เงินต้นและค่าปรับเป็น 0 ทั้งคู่)';
  end if;

  -- งวดเป้าหมายเดิม (0115) = fallback ขั้น 3
  v_penalty_target_id := (
    select i.id
      from public.installments i
     where i.contract_id = p_contract_id
       and coalesce(i.penalty_amount, 0) > public.penalty_paid_for_installment(i.id)
     order by i.installment_no
     limit 1
  );
  if v_penalty_target_id is null then
    v_penalty_target_id := (
      select id
        from public.installments
       where contract_id = p_contract_id
         and paid_at is null
       order by installment_no
       limit 1
    );
  end if;

  -- ====== จัดสรรค่าปรับ ======
  if coalesce(p_penalty, 0) > 0 then
    v_left := p_penalty;

    -- ขั้น 1: ลงเท่ายอดค้างของแต่ละงวด
    for rec in
      select i.id,
             coalesce(i.penalty_amount, 0) - public.penalty_paid_for_installment(i.id) as owed
        from public.installments i
       where i.contract_id = p_contract_id
       order by i.installment_no
    loop
      exit when v_left <= 0;
      continue when rec.owed <= 0;
      v_a := least(rec.owed, v_left);
      v_alloc := jsonb_set(v_alloc, array[rec.id::text],
                           to_jsonb(coalesce((v_alloc ->> rec.id::text)::numeric, 0) + v_a), true);
      v_left := v_left - v_a;
    end loop;

    -- ขั้น 2: ที่เหลือลงงวดที่ยังไม่จ่ายเงินต้นและเลยกำหนดแล้ว ไม่เกินเพดาน
    if v_left > 0 then
      v_per_day  := (select value::numeric from public.app_settings where key = 'penalty_per_day');
      v_max_days := (select value::numeric from public.app_settings where key = 'penalty_max_days');
      v_cap := coalesce(v_per_day, 0) * coalesce(v_max_days, 0);

      for rec in
        select i.id,
               i.due_date,
               public.penalty_paid_for_installment(i.id) as paid_pen
          from public.installments i
         where i.contract_id = p_contract_id
           and i.paid_at is null
           and i.due_date < v_paid_date
         order by i.due_date, i.installment_no
      loop
        exit when v_left <= 0;
        v_cur := rec.paid_pen + coalesce((v_alloc ->> rec.id::text)::numeric, 0);
        -- เพดานต่องวด: ไม่เกินเพดานเต็ม และไม่เกินจำนวนวันที่เลยกำหนดจริง ณ วันจ่าย (date - date = จำนวนวัน)
        v_cap_i := least(v_cap, coalesce(v_per_day, 0) * (v_paid_date - rec.due_date));
        continue when v_cur >= v_cap_i;
        v_a := least(v_cap_i - v_cur, v_left);
        v_alloc := jsonb_set(v_alloc, array[rec.id::text],
                             to_jsonb(coalesce((v_alloc ->> rec.id::text)::numeric, 0) + v_a), true);
        v_left := v_left - v_a;
      end loop;
    end if;

    -- ขั้น 3: ที่เหลือลงงวดเป้าหมายเดิม
    if v_left > 0 then
      if v_penalty_target_id is null then
        raise exception 'ไม่มีงวดให้ลงค่าปรับ (ไม่พบงวดที่มีค่าปรับค้างชำระ หรืองวดที่ยังไม่ปิด)';
      end if;
      v_alloc := jsonb_set(v_alloc, array[v_penalty_target_id::text],
                           to_jsonb(coalesce((v_alloc ->> v_penalty_target_id::text)::numeric, 0) + v_left), true);
    end if;
  end if;

  -- ====== เงินต้น (ถ้ามี) ======
  if p_principal > 0 then
    v_rem := p_principal;

    for rec in
      select id, amount, coalesce(paid_amount, 0) as paid
        from public.installments
       where contract_id = p_contract_id
         and paid_at is null
       order by installment_no
    loop
      gap  := rec.amount - rec.paid;
      take := least(gap, v_rem);

      continue when take <= 0;

      -- แนบค่าปรับที่จัดสรรให้งวดนี้ในแถวเดียวกัน แล้วตัดออกจาก v_alloc
      pen := coalesce((v_alloc ->> rec.id::text)::numeric, 0);
      if pen > 0 then
        v_alloc := v_alloc - rec.id::text;
      end if;

      new_paid := rec.paid + take;
      fully    := new_paid >= rec.amount and rec.amount > 0;

      insert into public.payment_log (
        installment_id, contract_id, action, amount, paid_amount_after, penalty_paid_amount, by_name
      ) values (
        rec.id, p_contract_id, 'pay', take + pen, new_paid, pen, p_by_name
      );

      update public.installments
         set paid_amount  = new_paid,
             paid_at      = case when fully then p_paid_at else null end,
             status       = case
                              when fully then 'paid'
                              else (case when due_date < current_date then 'late' else 'pending' end)
                            end,
             paid_by_name = case when fully then p_by_name else null end
       where id = rec.id;

      v_last_touched := rec.id;
      v_rem   := v_rem - take;
      v_recorded := true;

      exit when v_rem <= 0;
    end loop;

    -- เศษเงินต้นเกิน (พฤติกรรมเดิม)
    if v_rem > 0 then
      if v_last_touched is not null then
        select coalesce(paid_amount, 0) into v_last_touched_paid
          from public.installments where id = v_last_touched;

        insert into public.payment_log (
          installment_id, contract_id, action, amount, paid_amount_after, penalty_paid_amount, by_name
        ) values (
          v_last_touched, p_contract_id, 'pay', v_rem, v_last_touched_paid + v_rem, 0, p_by_name
        );

        update public.installments set paid_amount = paid_amount + v_rem where id = v_last_touched;
        v_recorded := true;
      else
        select id, coalesce(paid_amount, 0) into v_last_id, v_last_paid
          from public.installments
         where contract_id = p_contract_id
         order by installment_no desc
         limit 1;

        if found then
          insert into public.payment_log (
            installment_id, contract_id, action, amount, paid_amount_after, penalty_paid_amount, by_name
          ) values (
            v_last_id, p_contract_id, 'pay', v_rem, v_last_paid + v_rem, 0, p_by_name
          );

          update public.installments set paid_amount = paid_amount + v_rem where id = v_last_id;
          v_recorded := true;
        end if;
      end if;
    end if;
  end if;

  -- ====== แถวค่าปรับล้วนของงวดที่ไม่ถูกแตะเงินต้น (ไม่แตะ paid_at/status) ======
  for rec in
    select i.id,
           coalesce(i.paid_amount, 0) as paid,
           (v_alloc ->> i.id::text)::numeric as pen
      from public.installments i
     where i.contract_id = p_contract_id
       and (v_alloc ->> i.id::text) is not null
     order by i.installment_no
  loop
    continue when rec.pen <= 0;
    insert into public.payment_log (
      installment_id, contract_id, action, amount, paid_amount_after, penalty_paid_amount, by_name
    ) values (
      rec.id, p_contract_id, 'pay', rec.pen, rec.paid, rec.pen, p_by_name
    );
    v_recorded := true;
  end loop;

  -- จดใบเสร็จ PJ (เดิมทุกอย่าง)
  if p_receipt_uuids is not null and v_recorded then
    insert into public.pj_applied_receipts (
      pj_receipt_uuid, contract_id, pj_invoice_no, pj_paid_date, amount, payment_type, source
    )
    select
      elem ->> 'uuid',
      p_contract_id,
      elem ->> 'invoice_no',
      nullif(elem ->> 'paid_date', '')::date,
      coalesce((elem ->> 'amount')::numeric, 0),
      elem ->> 'payment_type',
      coalesce(elem ->> 'source', 'auto')
    from jsonb_array_elements(p_receipt_uuids) as elem
    where elem ->> 'uuid' is not null
    on conflict (pj_receipt_uuid) do nothing;
  end if;
end;
$$;

grant execute on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb)
  to authenticated, service_role;

comment on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb) is
  '(0181) ตัดเงินต้นกระจายหลายงวด + จัดสรรค่าปรับก่อนลง: 1) เท่ายอดค้างรายงวด 2) ส่วนเหลือลงงวดยังไม่จ่าย+เลยกำหนด ไม่เกินเพดาน 3) ที่เหลือลงงวดเป้าหมายเดิม (0115); งวดที่แตะเงินต้นแนบค่าปรับในแถวเดียวกัน งวดอื่นใช้แถวค่าปรับล้วน; p_receipt_uuids (0100/0113) เดิม';

-- Verify (รันเองใน begin/rollback หลัง apply; ห้าม commit ข้อมูลทดสอบ):
--   begin;
--     -- เลือกสัญญา active ที่มีงวดค้างค่าปรับ 2 งวดขึ้นไป แล้วลงค่าปรับล้วน:
--     select public.record_payment_spread('<contract_id>'::uuid, 0, 700, timestamptz '2026-11-03 00:00:00+00', 'VERIFY', null);
--     -- ตรวจ: sum(penalty_paid_amount) ของแถวใหม่ใน payment_log = 700 และกระจายหลายงวดตามยอดค้าง/เพดานต่องวด
--     select installment_id, amount, penalty_paid_amount from public.payment_log
--      where contract_id = '<contract_id>'::uuid and by_name = 'VERIFY' order by created_at;
--   rollback;
