-- 0184: record_payment_spread จองใบเสร็จ PJ (pj_applied_receipts) ก่อนลงเงิน กัน pj-sync ลงเงินเบิ้ลตอนชนกับปุ่มกล่องรอตรวจ/รอบซ้อน
--
-- ปัญหา: 0181 insert pj_applied_receipts ท้ายฟังก์ชันด้วย on conflict do nothing แล้วลงเงินไปแล้วเสมอ
--   cron อ่านเซ็ต "ใบที่ลงแล้ว" ครั้งเดียวก่อนเรียก RPC; ถ้าระหว่างนั้นพนักงานกดลงตาม PJ (apply_pj_review_payment, 0183 จอง uuid แล้ว commit)
--   cron ยังเรียก RPC ด้วย uuid เดิม -> conflict ถูกกลืน แต่เงินลงซ้ำ
-- แก้: จองก่อนแตะงวด/payment_log; จองไม่ครบ = raise (SQLSTATE PJ409, ข้อความ [PJS:RECEIPT_ALREADY_APPLIED]) rollback ทั้งก้อน ไม่ลงเงินเลย
--   เปลี่ยนเฉพาะส่วนจองใบเสร็จ; การกระจายเงินต้น/ค่าปรับ/log ทุกบรรทัดเท่า 0181; signature, grant, security เท่าเดิม; p_receipt_uuids null ทำงานเดิม
-- ขึ้นระบบ: apply migration นี้ก่อนหรือหลัง deploy pj-sync ก็ปลอดภัย (pj-sync รุ่นเก่าเจอ error นี้จะเข้ากล่อง AMOUNT_MISMATCH เป็น noise แต่ไม่มีเงินลง/เบิ้ล)
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
  v_expected_uuids text[] := '{}';   -- uuid ไม่ซ้ำที่ต้องจอง (เรียงตามลำดับในอาร์เรย์)
  v_claimed_uuids  text[] := '{}';   -- uuid ที่จองสำเร็จในรอบนี้
  v_conflicting    text[];
begin
  if coalesce(p_principal, 0) < 0 or coalesce(p_penalty, 0) < 0 then
    raise exception 'ยอดติดลบไม่ถูกต้อง (เงินต้น=%, ค่าปรับ=%)', p_principal, p_penalty;
  end if;

  if coalesce(p_principal, 0) <= 0 and coalesce(p_penalty, 0) <= 0 then
    raise exception 'ไม่มียอดให้บันทึก (เงินต้นและค่าปรับเป็น 0 ทั้งคู่)';
  end if;

  -- ====== (0184) จองใบเสร็จ PJ ก่อนแตะงวด/payment_log ======
  -- insert pj_applied_receipts ก่อนลงเงินทุกอย่าง; ถ้าจองไม่ครบ (ใบไหนมีคนลงไปแล้ว/กำลังลงอยู่ใน tx อื่น) -> raise ทันที
  --   rollback ทั้งก้อน ไม่ลงเงินสักบาท และไม่ทิ้ง claim ค้าง (ใบที่จองได้ในรอบนี้ถูก rollback ไปด้วย)
  -- ถ้า tx อื่นถือ uuid เดียวกันอยู่ (ยังไม่ commit) insert จะรอที่ unique index จน tx นั้นจบ แล้วค่อยตัดสิน
  -- เรียงตามลำดับในอาร์เรย์ (with ordinality) ให้ตรงกับ apply_pj_review_payment (0183) กัน lock วนข้ามฟังก์ชัน
  -- p_receipt_uuids = null / [] : ไม่จองอะไร ทำงานเหมือนเดิม
  if p_receipt_uuids is not null and jsonb_typeof(p_receipt_uuids) = 'array' then
    select coalesce(array_agg(g.u order by g.o), '{}'::text[])
      into v_expected_uuids
      from (
        select x.u, min(x.o) as o
          from (select t.elem ->> 'uuid' as u, t.ord as o
                  from jsonb_array_elements(p_receipt_uuids) with ordinality as t(elem, ord)) x
         where x.u is not null
         group by x.u
      ) g;

    if coalesce(array_length(v_expected_uuids, 1), 0) > 0 then
      with ins as (
        insert into public.pj_applied_receipts (
          pj_receipt_uuid, contract_id, pj_invoice_no, pj_paid_date, amount, payment_type, source
        )
        select
          d.u,
          p_contract_id,
          d.elem ->> 'invoice_no',
          nullif(d.elem ->> 'paid_date', '')::date,
          coalesce((d.elem ->> 'amount')::numeric, 0),
          d.elem ->> 'payment_type',
          coalesce(d.elem ->> 'source', 'auto')
        from (
          select distinct on (t.elem ->> 'uuid')
                 t.elem ->> 'uuid' as u, t.elem, t.ord
            from jsonb_array_elements(p_receipt_uuids) with ordinality as t(elem, ord)
           where t.elem ->> 'uuid' is not null
           order by t.elem ->> 'uuid', t.ord
        ) d
        order by d.ord
        on conflict (pj_receipt_uuid) do nothing
        returning pj_receipt_uuid
      )
      select coalesce(array_agg(ins.pj_receipt_uuid), '{}'::text[]) into v_claimed_uuids from ins;

      if coalesce(array_length(v_claimed_uuids, 1), 0) < array_length(v_expected_uuids, 1) then
        select array_agg(e.u) into v_conflicting
          from unnest(v_expected_uuids) as e(u)
         where not (e.u = any(v_claimed_uuids));
        raise exception '[PJS:RECEIPT_ALREADY_APPLIED] ใบเสร็จ PJ ถูกลงไปแล้ว % ใบ จากทั้งหมด % ใบ ไม่ลงเงินซ้ำ',
          coalesce(array_length(v_conflicting, 1), 0), array_length(v_expected_uuids, 1)
          using errcode = 'PJ409', detail = array_to_string(v_conflicting, ',');
      end if;
    end if;
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

  -- (0184) จองไว้แล้วตอนต้น: ถ้ารอบนี้ไม่ได้ลงเงินจริงสักบาท (v_recorded=false) ปล่อยใบที่จองไว้คืน
  --   ให้พฤติกรรมเท่า 0181 (เดิมจดใบเสร็จเฉพาะเมื่อมีเงินลงจริง) ไม่ทิ้งใบ "ลงแล้ว" ที่ไม่มีเงินรองรับ
  if not v_recorded and coalesce(array_length(v_claimed_uuids, 1), 0) > 0 then
    delete from public.pj_applied_receipts where pj_receipt_uuid = any(v_claimed_uuids);
  end if;
end;
$$;

grant execute on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb)
  to authenticated, service_role;

comment on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb) is
  '(0184) เหมือน 0181 (เงินต้นกระจายหลายงวด + ค่าปรับตามงวดจริง) แต่จองใบเสร็จ PJ ใน pj_applied_receipts ก่อนลงเงิน: ใบไหนจองไม่ได้ -> raise PJ409 [PJS:RECEIPT_ALREADY_APPLIED] ไม่ลงเงินทั้งก้อน; p_receipt_uuids null = ไม่จอง';

-- Verify หลัง apply:
--   select has_function_privilege('service_role', 'public.record_payment_spread(uuid,numeric,numeric,timestamptz,text,jsonb)', 'EXECUTE'); -- true
--   select has_function_privilege('authenticated', 'public.record_payment_spread(uuid,numeric,numeric,timestamptz,text,jsonb)', 'EXECUTE'); -- true
--   select prosrc like '%PJS:RECEIPT_ALREADY_APPLIED%' from pg_proc where proname = 'record_payment_spread';
