-- 0185: ทุกทางลงเงินบนสัญญาเดียวกันเข้าคิวรายสัญญา (ล็อกแถว contracts) กันยอดงวดเพี้ยนเมื่อลงเงินคนละใบพร้อมกัน
--
-- ปัญหา: record_payment_spread (0184) อ่าน paid_amount/ค่าปรับของงวดก่อน แล้วค่อยเขียน new_paid := rec.paid + take โดยไม่ล็อก
--   สอง tx คนละใบบนสัญญาเดียว: ทั้งคู่อ่านค่าเดิม -> payment_log 2 แถว แต่ paid_amount นับครั้งเดียว และจัดสรรค่าปรับอ่านค้าง
--   (ล็อกสัญญาเดิมของ trigger track_extension_activity 0171 มาถึงตอนเขียนแถวแรก ซึ่งช้าเกินไป หลังอ่านงวดไปแล้ว)
-- แก้: ใส่ `perform 1 from public.contracts where id = ... for update;` แบบเดียวกันทุกทางลงเงิน (เหมือน settle/close/restructure/undo ที่ล็อกสัญญาก่อนอยู่แล้ว)
--   เลือก row lock แทน advisory lock: ใช้ล็อกชนิดเดียวกับ trigger 0171 และ autoclose 0124 (FOR UPDATE ที่ contracts) และกับฟังก์ชันโครงสร้างสัญญาเดิม
--   จึงต่อคิวเดียวกันโดยอัตโนมัติ ไม่ต้องให้ทุกฝั่งร่วมมือ และไม่มีการอัปเกรดล็อกกลาง tx; advisory lock จะไม่ชนกับล็อกของ trigger เลย
-- ลำดับล็อก: record_payment_spread = (แถวรอตรวจ ->) ใบเสร็จ -> สัญญา -> งวด -> payment_log; ฟังก์ชันรายงวด = สัญญา -> งวด -> payment_log
--   (เดิมฟังก์ชันรายงวดล็อกงวดก่อนแล้ว trigger ค่อยไปล็อกสัญญา สวนทางกับ record_payment_spread = วงล็อกวนได้)
-- ฟังก์ชันที่แก้ (เพิ่มเฉพาะบรรทัดล็อก ที่เหลือเหมือนรุ่นล่าสุดทุกบรรทัด; signature/security/search_path/grant เดิม):
--   record_payment_spread (0184), record_payment_with_penalty (0040), record_penalty_only_payment (0147),
--   record_payment / adjust_payment / cancel_payment (0018)
-- ไม่ใส่ lock_timeout: ผู้ถือล็อกเป็น tx สั้น; เว็บมี statement_timeout ของ role อยู่แล้ว; ถ้าใส่ cron จะเจอ error แล้วสร้างแถว AMOUNT_MISMATCH เป็น noise
-- ขึ้นระบบ: apply migration นี้อย่างเดียว ไม่ต้อง deploy เว็บ/pj-sync
-- Additive: create or replace signature เดิมทั้งหมด (ACL เดิมคงอยู่)

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

  -- ====== (0185) เข้าคิวรายสัญญา ======
  -- ล็อกแถวสัญญาหลังจองใบเสร็จ (ลำดับ: แถวรอตรวจ -> ใบเสร็จ -> สัญญา) แต่ก่อนอ่านงวด/ค่าปรับใดๆ
  -- tx ที่สองบนสัญญาเดียวกันจะรอตรงนี้จน tx แรก commit แล้วอ่าน paid_amount/ค่าปรับค้างล่าสุด (READ COMMITTED: แต่ละ statement เห็นข้อมูลใหม่)
  -- ล็อกชนิด FOR UPDATE ตัวเดียวกับ track_extension_activity (0171) / autoclose (0124) จึงไม่ต้องอัปเกรดล็อกกลาง tx
  perform 1 from public.contracts where id = p_contract_id for update;

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
  -- (0185) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread
  select contract_id into v_contract_id from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_contract_id for update;
  end if;

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

create or replace function public.record_penalty_only_payment(
  p_installment_id uuid,
  p_penalty        numeric,
  p_by_name        text,
  p_paid_at        timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_contract_id      uuid;
  v_penalty_amount   numeric;
  v_paid_amount      numeric;
  v_already_paid     numeric;
  v_remaining        numeric;
begin
  -- guard: ค่าปรับต้อง > 0 เท่านั้น (ปุ่มนี้ทำหน้าที่เดียว เก็บค่าปรับ ห้ามเรียกด้วย 0/ติดลบ)
  if p_penalty is null or p_penalty <= 0 then
    raise exception 'ยอดค่าปรับต้องมากกว่า 0 บาท: %', p_penalty;
  end if;

  -- (0185) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread
  select contract_id into v_contract_id from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_contract_id for update;
  end if;

  -- ล็อกแถวงวดกัน concurrent เก็บซ้ำพร้อมกัน + โหลดค่าที่ต้องใช้
  select contract_id, coalesce(penalty_amount, 0), coalesce(paid_amount, 0)
    into v_contract_id, v_penalty_amount, v_paid_amount
    from public.installments
   where id = p_installment_id
     for update;

  if not found then
    raise exception 'ไม่พบงวดผ่อนนี้: %', p_installment_id;
  end if;

  -- ยอดค่าปรับที่เก็บไปแล้วจริงสะสมของงวดนี้ (mirror calc.ts penaltyPaidForInstallment ผ่าน 0115)
  v_already_paid := public.penalty_paid_for_installment(p_installment_id);
  v_remaining    := v_penalty_amount - v_already_paid;

  -- guard: ห้ามเก็บเกินยอดค่าปรับที่ตั้งไว้ของงวดนั้น
  if p_penalty > v_remaining then
    raise exception 'เก็บค่าปรับเกินยอดที่ค้างจริง (เหลือเก็บได้อีก % บาท)', v_remaining;
  end if;

  -- INSERT payment_log แถวเดียว — ห้ามแตะ installments แม้แต่คอลัมน์เดียว
  -- trigger set_payment_log_actor (BEFORE INSERT) + trg_clear_promise_on_pay (AFTER INSERT) ยังทำงานตามปกติ
  insert into public.payment_log (
    installment_id,
    contract_id,
    action,
    amount,               -- ยอดรับจริง = ค่าปรับล้วน
    paid_amount_after,    -- principal สะสม "ไม่เปลี่ยน" จากเดิม
    penalty_paid_amount,
    by_name
  ) values (
    p_installment_id,
    v_contract_id,
    'pay',
    p_penalty,
    v_paid_amount,
    p_penalty,
    p_by_name
  );

  -- 🔴 เจตนา: ไม่มี UPDATE public.installments ในฟังก์ชันนี้เลย — นี่คือหัวใจของ fix
end;
$$;

create or replace function public.record_payment(
  p_installment_id uuid,
  p_amount numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
  v_lock_cid uuid;
  v_new  numeric;
  v_uid  uuid := auth.uid();
  v_name text;
begin
  -- SECURITY GUARD: freelancer role may not call write RPCs
  if not (is_admin() or (select role from profiles where id = auth.uid()) = 'staff') then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  -- (0185) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread
  select contract_id into v_lock_cid from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_lock_cid for update;
  end if;
  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  v_new := coalesce(v_inst.paid_amount, 0) + coalesce(p_amount, 0);
  select coalesce(nullif(p.full_name, ''), u.email, '') into v_name
    from auth.users u left join profiles p on p.id = u.id where u.id = v_uid;

  if v_new >= v_inst.amount and v_inst.amount > 0 then
    -- จ่ายครบ → ปิดงวด
    update installments set
      paid_amount = v_new,
      paid_at = coalesce(paid_at, now()),
      status = 'paid',
      paid_by = v_uid,
      paid_by_name = v_name
      where id = p_installment_id;
  else
    -- จ่ายบางส่วน → งวดยังเปิด
    update installments set
      paid_amount = v_new,
      paid_at = null,
      status = case when due_date < current_date then 'late' else 'pending' end,
      paid_by = null,
      paid_by_name = null
      where id = p_installment_id;
  end if;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'pay', coalesce(p_amount, 0), v_new, p_note);
end;
$$;

create or replace function public.adjust_payment(
  p_installment_id uuid,
  p_new_total numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
  v_lock_cid uuid;
  v_total numeric;
  v_uid  uuid := auth.uid();
  v_name text;
begin
  -- SECURITY GUARD: freelancer role may not call write RPCs
  if not (is_admin() or (select role from profiles where id = auth.uid()) = 'staff') then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  -- (0185) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread
  select contract_id into v_lock_cid from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_lock_cid for update;
  end if;
  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  v_total := greatest(coalesce(p_new_total, 0), 0);
  select coalesce(nullif(p.full_name, ''), u.email, '') into v_name
    from auth.users u left join profiles p on p.id = u.id where u.id = v_uid;

  if v_total >= v_inst.amount and v_inst.amount > 0 then
    update installments set
      paid_amount = v_total,
      paid_at = coalesce(paid_at, now()),
      status = 'paid',
      paid_by = v_uid,
      paid_by_name = v_name
      where id = p_installment_id;
  else
    update installments set
      paid_amount = v_total,
      paid_at = null,
      status = case when due_date < current_date then 'late' else 'pending' end,
      paid_by = null,
      paid_by_name = null
      where id = p_installment_id;
  end if;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'edit', v_total, v_total, p_note);
end;
$$;

create or replace function public.cancel_payment(
  p_installment_id uuid,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
  v_lock_cid uuid;
begin
  -- SECURITY GUARD: freelancer role may not call write RPCs
  if not (is_admin() or (select role from profiles where id = auth.uid()) = 'staff') then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  -- (0185) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread
  select contract_id into v_lock_cid from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_lock_cid for update;
  end if;
  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  update installments set
    paid_amount = 0,
    paid_at = null,
    status = case when due_date < current_date then 'late' else 'pending' end,
    paid_by = null,
    paid_by_name = null
    where id = p_installment_id;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'cancel', 0, 0, p_note);
end;
$$;

-- Verify หลัง apply:
--   select proname, prosrc like '%(0185)%' as has_lock from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('record_payment_spread','record_payment_with_penalty','record_penalty_only_payment','record_payment','adjust_payment','cancel_payment'); -- ทุกแถว true
--   select has_function_privilege('authenticated', 'public.record_payment_spread(uuid,numeric,numeric,timestamptz,text,jsonb)', 'EXECUTE'); -- true
--   select has_function_privilege('service_role', 'public.record_payment_spread(uuid,numeric,numeric,timestamptz,text,jsonb)', 'EXECUTE'); -- true
