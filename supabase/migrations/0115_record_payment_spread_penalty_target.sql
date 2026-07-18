-- 0115: แก้บั๊ก "ค่าปรับลงผิดงวด" ใน record_payment_spread (แบมสเปค 18 ก.ค. 2026)
--
-- ============================================================================
-- บั๊กเดิม (0079/0113 body):
--   งวดที่ใส่ค่าปรับ = งวดแรกที่ "เงินต้นยังไม่จ่าย" (paid_at is null, order by installment_no)
--   → ถ้างวดที่ 1 เงินต้นปิดไปแล้วแต่ยังมีค่าปรับค้าง (เช่น จ่ายเงินต้นครบแต่ไม่เคยจ่ายค่าปรับ) ค่าปรับรอบใหม่
--     จะไหลไปลงงวดถัดไปที่เงินต้นยังไม่ปิด — ผิดงวด ทำให้ตาราง "ค่าปรับค้างต่องวด" (penaltyPaidForInstallment,
--     calc.ts) นับผิด และรายงานค่าปรับค้างของลูกค้าคลาดเคลื่อน
--
-- Pete อนุมัติกฎ (18 ก.ค. 2026):
--   ค่าปรับต้องลงที่ "งวดที่มีค่าปรับค้างจริง" (installments.penalty_amount > ค่าปรับที่จ่ายแล้วสะสม
--   ของงวดนั้น จาก penalty_paid_for_installment) เก่าสุดก่อน (installment_no น้อยสุด) — ไม่สนว่าเงินต้น
--   งวดนั้นปิดไปแล้วหรือยัง ถ้าไม่มีงวดไหนมีค่าปรับค้างเลย → fallback งวดที่เงินต้นยังไม่จ่าย (unpaid) ตัวแรก
--   (พฤติกรรมเดิม ใช้เมื่อค่าปรับเพิ่งถูก assess ยังไม่มีในระบบ/edge case)
--
-- ทางแก้:
--   1) เพิ่ม helper public.penalty_paid_for_installment(uuid) — mirror logic ของ
--      src/lib/calc.ts penaltyPaidForInstallment() ฝั่ง SQL: เรียง payment_log ตาม created_at,
--      action='cancel' reset running total = 0, action='pay' บวก penalty_paid_amount, action='edit'
--      ไม่มีผล (0-contribution) — เขียนแบบ set-based เทียบเท่า sequential logic เดิม โดยใช้
--      "sum penalty_paid_amount ของแถว pay ที่เกิดหลัง cancel ล่าสุด" (คณิตศาสตร์เท่ากับ reset-then-accumulate
--      เพราะ cancel ล่าสุดคือจุด reset สุดท้าย ไม่มี cancel ใดหลังจากนั้นอีก)
--   2) คำนวณ v_penalty_target_id ครั้งเดียวหลัง guards เดิม (negative/both-zero) ก่อนแยก branch:
--      หา installment แรก (installment_no น้อยสุด) ที่ penalty_amount > penalty_paid_for_installment(id)
--      ถ้าไม่มี → fallback งวด unpaid (paid_at is null) แรกสุด (พฤติกรรมเดิม)
--   3) penalty-only branch (p_principal<=0, p_penalty>0): ใช้ v_penalty_target_id ตรงๆ แทนการ query
--      เอง (เดิม query เฉพาะ unpaid) — ถ้า null → raise exception (เปลี่ยนข้อความให้ครอบคลุมทั้งสองเงื่อนไข)
--   4) principal>0 branch: เปลี่ยนเงื่อนไขใส่ pen จาก "v_first" (งวดแรกที่ตัดเงินต้น) เป็น
--      "rec.id = v_penalty_target_id" (งวดที่มีค่าปรับค้างจริง/fallback unpaid แรก) — ถ้างวดที่มีค่าปรับค้าง
--      ไม่ตรงกับงวดที่ loop นี้กำลังตัดเงินต้นเลย (เช่น ค่าปรับค้างอยู่ที่งวด 1 ที่ปิดไปแล้ว แต่ loop กำลังตัด
--      งวด 3-4) → pen จะไม่ถูกใส่ในลูปเลย ต้องมี fallback block ท้าย function (ข้อ 5) มาจัดการ
--   5) เพิ่ม fallback block หลัง overpay/leftover (ก่อน pj_applied_receipts section): ถ้า p_penalty > 0
--      และยังไม่เคยแนบ pen เข้า loop เลย (v_penalty_attached = false) → insert payment_log แถวใหม่ที่
--      v_penalty_target_id ตรงๆ (ไม่แตะ installments.paid_amount ของงวดนั้น เพราะเงินต้นงวดนั้นอาจปิดไปแล้ว
--      หรือยังไม่ถึงคิวเงินต้นก็ได้ — สอดคล้องกับ penalty-only branch เดิมที่ไม่แตะ installments เวลาลงค่าปรับ
--      แยกจากเงินต้น) — คงตรรกะเดิม: ค่าปรับกับเงินต้นเป็นคนละมิติกัน ไม่ auto-sync paid_amount/paid_at
--
-- ไม่แตะ: negative guard, both-zero guard, receipt gate (v_recorded), overpay/leftover logic เดิม,
-- shape payment_log ของ path ปกติ (งวดที่เงินต้นตัด = งวดค่าปรับค้าง → ยังลงแถวเดียวรวม take+pen)
--
-- Signature เดิมเป๊ะ (ไม่เปลี่ยน) — CREATE OR REPLACE ตรงๆ พอ ไม่ต้อง DROP:
--   record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb)
-- caller ไม่ต้องแก้: src/lib/db.ts applyPjReviewPayment, supabase/functions/pj-sync/index.ts
-- ============================================================================


-- ============================================================================
-- PART A: helper function — mirror penaltyPaidForInstallment (calc.ts) ฝั่ง SQL
-- ============================================================================
create or replace function public.penalty_paid_for_installment(p_installment_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_total numeric := 0;
  v_last_cancel_at timestamptz;
begin
  select max(created_at) into v_last_cancel_at
    from public.payment_log
   where installment_id = p_installment_id
     and action = 'cancel';

  select coalesce(sum(penalty_paid_amount), 0) into v_total
    from public.payment_log
   where installment_id = p_installment_id
     and action = 'pay'
     and (v_last_cancel_at is null or created_at > v_last_cancel_at);

  return coalesce(v_total, 0);
end;
$$;

grant execute on function public.penalty_paid_for_installment(uuid)
  to authenticated, service_role;

comment on function public.penalty_paid_for_installment(uuid) is
  'ค่าปรับที่จ่ายแล้วจริงสะสมของงวดเดียว (mirror src/lib/calc.ts penaltyPaidForInstallment) — cancel reset, pay สะสม, edit ไม่มีผล; ใช้โดย record_payment_spread (0115) เลือกงวดเป้าค่าปรับ';


-- ============================================================================
-- PART B: record_payment_spread — แก้ target เลือกงวดค่าปรับ
-- ============================================================================
create or replace function public.record_payment_spread(
  p_contract_id    uuid,
  p_principal      numeric,     -- เงินต้นรวมที่ชำระ (ไม่รวมค่าปรับ)
  p_penalty        numeric,     -- ค่าปรับทั้งก้อน (ใส่งวดที่มีค่าปรับค้างจริงเก่าสุด — 0115)
  p_paid_at        timestamptz, -- เวลาชำระ (UTC midnight ลงท้าย Z เสมอ)
  p_by_name        text,        -- ชื่อผู้บันทึก
  p_receipt_uuids  jsonb default null -- [{uuid, invoice_no, paid_date, amount, payment_type, source}] — null = ข้าม (caller เดิม/manual)
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rem      numeric;   -- ยอดคงเหลือที่ยังต้องตัด
  v_recorded boolean := false;  -- (0113) true เมื่อมีการ insert payment_log จริงอย่างน้อย 1 แถว — gate ให้ pj_applied_receipts
  -- (0115) เป้าหมายงวดค่าปรับ — คำนวณครั้งเดียวก่อนแยก branch
  v_penalty_target_id   uuid;
  v_penalty_attached    boolean := false;  -- true เมื่อ loop เงินต้นแนบ pen เข้า v_penalty_target_id ไปแล้ว
  -- ตัวแปร loop
  rec        record;    -- (id, amount, paid)
  gap        numeric;   -- ช่องว่างของงวด = amount − paid
  take       numeric;   -- ที่ตัดจริงจากงวดนี้ = least(gap, v_rem)
  pen        numeric;   -- ค่าปรับที่ใส่งวดนี้ (เฉพาะงวดเป้าหมายค่าปรับ)
  new_paid   numeric;   -- paid_amount หลังตัด
  fully      boolean;   -- ปิดงวดสำเร็จหรือเปล่า
  -- ตัวแปรสำหรับ overpay
  v_last_id        uuid;
  v_last_paid      numeric;
  v_last_touched   uuid := null;  -- งวด unpaid ตัวท้ายที่ loop เพิ่งตัด (เป้าใส่เศษ ให้ตรง client paymentSpread.ts)
  v_last_touched_paid numeric;
  -- (0113) ตัวแปรสำหรับ penalty-only branch / (0115) fallback block ท้าย function
  v_ref_paid numeric;
begin
  -- (0113) guard: ยอดติดลบ — เช็คก่อนอย่างอื่น (fail fast) กัน p_principal ติดลบ + p_penalty บวก
  -- หลุดผ่าน guard both-zero ด้านล่างแล้วตกลงไป penalty-only branch แบบเงียบ (ค่าติดลบถูกทิ้งไม่มี
  -- คำเตือน — ติ๊กจับ 16 ก.ค. 2026: PjSyncReview.tsx input number ไม่มี min="0")
  if coalesce(p_principal, 0) < 0 or coalesce(p_penalty, 0) < 0 then
    raise exception 'ยอดติดลบไม่ถูกต้อง (เงินต้น=%, ค่าปรับ=%)', p_principal, p_penalty;
  end if;

  -- (0113) guard: เรียกมั่วทั้งสองยอด <= 0 → error ชัดเจน ดีกว่าเงียบแล้วไม่มีอะไรเกิดขึ้น
  if coalesce(p_principal, 0) <= 0 and coalesce(p_penalty, 0) <= 0 then
    raise exception 'ไม่มียอดให้บันทึก (เงินต้นและค่าปรับเป็น 0 ทั้งคู่)';
  end if;

  -- (0115) คำนวณเป้าหมายงวดค่าปรับครั้งเดียว ก่อนแยก branch — ใช้ทั้ง penalty-only branch และ
  -- principal>0 branch ด้านล่าง
  -- ลำดับความสำคัญ: 1) งวดที่มีค่าปรับค้างจริง (penalty_amount > จ่ายแล้วสะสม) เก่าสุดก่อน
  --                  2) ไม่มีงวดไหนมีค่าปรับค้างเลย → fallback งวด unpaid (เงินต้นยังไม่จ่าย) แรกสุด
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

  if p_principal <= 0 and p_penalty > 0 then
    -- ============================================================================
    -- PENALTY-ONLY BRANCH — เงินต้น=0 มีแต่ค่าปรับ (0113 เดิม, 0115 เปลี่ยนแค่ที่มาของ target)
    -- ไม่แตะ installments (paid_amount/paid_at/status/paid_by_name) เพราะเงินต้นไม่ถูกจ่ายตามนิยาม
    -- ============================================================================
    if v_penalty_target_id is null then
      -- ไม่มีงวดค้าง (ทั้งค่าปรับค้างและเงินต้นค้าง) ให้ลงค่าปรับ → ห้ามแตะ payment_log/pj_applied_receipts เลย
      raise exception 'ไม่มีงวดให้ลงค่าปรับ (ไม่พบงวดที่มีค่าปรับค้างชำระ หรืองวดที่ยังไม่ปิด)';
    end if;

    select coalesce(paid_amount, 0) into v_ref_paid
      from public.installments
     where id = v_penalty_target_id;

    insert into public.payment_log (
      installment_id,
      contract_id,
      action,
      amount,               -- ยอดรับจริง = ค่าปรับล้วน (ไม่มีเงินต้น)
      paid_amount_after,    -- principal สะสม "ไม่เปลี่ยน" — เงินต้นไม่ถูกแตะ
      penalty_paid_amount,
      by_name
    ) values (
      v_penalty_target_id,
      p_contract_id,
      'pay',
      p_penalty,
      v_ref_paid,
      p_penalty,
      p_by_name
    );

    v_recorded := true;

  else
    -- ============================================================================
    -- PRINCIPAL > 0 BRANCH — logic เดิมจาก 0079/0100/0113 ไม่เปลี่ยนโครง มีแค่เงื่อนไขใส่ pen (0115)
    -- ============================================================================
    v_rem   := p_principal;

    -- วนงวดที่ยังไม่จ่าย (paid_at is null) เรียงตาม installment_no
    -- ⚠️ order by installment_no อาจ ≠ ลำดับ due_date จริงในสัญญาที่ขยายเวลา (inherit เดิม ไม่ใช่บั๊กใหม่)
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

      -- (0115) pen ใส่เฉพาะงวดเป้าหมายค่าปรับ (v_penalty_target_id) ไม่ใช่ "งวดแรกที่ตัดเงินต้น" อีกต่อไป
      pen := case when p_penalty > 0 and rec.id = v_penalty_target_id then p_penalty else 0 end;
      if pen > 0 then
        v_penalty_attached := true;
      end if;

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

      v_last_touched := rec.id;   -- เก็บงวดล่าสุดที่ตัด (เศษเกินจะลงงวดนี้ ให้ตรงกับ client)
      v_rem   := v_rem - take;
      v_recorded := true;

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

        v_recorded := true;

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

          v_recorded := true;
        end if;
      end if;
    end if;

    -- (0115) fallback: ยังมีค่าปรับที่ต้องลง แต่ loop เงินต้นข้างบนไม่เคยแนบ pen เข้า v_penalty_target_id เลย
    -- (เช่น งวดที่มีค่าปรับค้างจริงปิดเงินต้นไปแล้ว ไม่อยู่ใน loop unpaid ข้างบน) → insert แถวค่าปรับแยก
    -- ตรงที่ v_penalty_target_id โดยไม่แตะ installments.paid_amount ของงวดนั้น (ค่าปรับกับเงินต้นคนละมิติ)
    if p_penalty > 0 and not v_penalty_attached then
      if v_penalty_target_id is null then
        raise exception 'ไม่มีงวดให้ลงค่าปรับ (ไม่พบงวดที่มีค่าปรับค้างชำระ หรืองวดที่ยังไม่ปิด)';
      end if;

      select coalesce(paid_amount, 0) into v_ref_paid
        from public.installments
       where id = v_penalty_target_id;

      insert into public.payment_log (
        installment_id,
        contract_id,
        action,
        amount,
        paid_amount_after,
        penalty_paid_amount,
        by_name
      ) values (
        v_penalty_target_id,
        p_contract_id,
        'pay',
        p_penalty,
        v_ref_paid,
        p_penalty,
        p_by_name
      );

      v_recorded := true;
    end if;
  end if;

  -- ── จด pj_applied_receipts ในทรานแซกชันเดียวกับการลงเงินด้านบน (atomic — 0100) ──────────────────
  --    p_receipt_uuids = null (default) → ข้าม ไม่แตะตารางนี้เลย (caller เดิม/ไม่มี uuid ให้จด)
  --    on conflict do nothing → idempotent ถ้า uuid ซ้ำ (ไม่ error ไม่เบิ้ล แม้เผลอส่งซ้ำ)
  --    🔴 (0113) เพิ่ม "and v_recorded" — ถ้า branch ข้างบนไม่ได้ลง payment_log จริงเลย (เช่นบั๊กเดิม
  --    penalty ถูกทิ้งเงียบ) ต้องไม่จด pj_applied_receipts เด็ดขาด ไม่งั้น cron จะเข้าใจว่า "ลงแล้ว"
  --    ทั้งที่เงินไม่เคยเข้าระบบ = เงินหายถาวร (นี่คือ root cause ของบั๊กที่แก้ใน 0113)
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

-- GRANT: signature ไม่เปลี่ยน (CREATE OR REPLACE ต่อ object เดิม) — สิทธิ์เดิมยังอยู่ แต่ grant ซ้ำไว้ชัดเจน
grant execute on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb)
  to authenticated, service_role;

comment on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb) is
  'ตัดยอดชำระกระจายหลายงวดตามลำดับ installment_no — เศษที่เกินบวกทับงวด unpaid ตัวท้ายที่เพิ่งตัด (ตรง client paymentSpread.ts) fallback งวดสุดท้ายถ้าไม่มีงวด unpaid; p_receipt_uuids (0100) จด pj_applied_receipts แบบ atomic เฉพาะเมื่อมีการลง payment_log จริง (v_recorded, 0113); (0113) p_principal<=0 and p_penalty>0 = penalty-only branch ไม่แตะ installments; ทั้งสองยอด<=0 หรือไม่มีงวดค้าง → raise exception แทนเงียบ; p_principal หรือ p_penalty ติดลบ → raise exception ทันที; (0115) ค่าปรับลงที่งวดที่มีค่าปรับค้างจริงเก่าสุด (penalty_amount > penalty_paid_for_installment) ไม่ใช่ "งวดแรกที่เงินต้นยังไม่จ่าย" อีกต่อไป — ถ้าไม่มีงวดไหนมีค่าปรับค้าง fallback งวด unpaid แรกสุด (พฤติกรรมเดิม)';

-- ============================================================================
-- Verify (ครีมรันหลัง apply — begin/rollback เท่านั้น ห้าม commit จริงตอนทดสอบ):
-- ============================================================================
--
-- 0) หา contract_id ทดสอบ — เคสสำคัญที่สุดคือสัญญาที่งวด 1 เงินต้นปิดแล้ว (paid_at not null) แต่ยัง
--    มี penalty_amount > 0 ค้างอยู่ (penalty_paid_for_installment(งวด1) < penalty_amount งวด1) ในขณะที่
--    งวด 2/3 ยัง unpaid — เดิมบั๊กจะเอาค่าปรับไปลงงวด 2 (unpaid แรก) ผิด ต้องได้ลงงวด 1 แทน
--
-- 1) penalty_paid_for_installment ตรง TS mirror (calc.ts penaltyPaidForInstallment) — sanity เทียบ
--    เคส cancel-reset (pay 100 → cancel → pay 50 ต้องได้ 50 ไม่ใช่ 150):
--   select public.penalty_paid_for_installment('<installment_id>'::uuid);
--
-- 2) core fix: ค่าปรับลงงวดที่มีค่าปรับค้างจริง (ไม่ใช่งวด unpaid แรก) เมื่อสองอันไม่ตรงกัน:
--   begin;
--     -- baseline: งวด1 ปิดเงินต้นแล้ว (paid_at not null) penalty_amount=300 ยังไม่เคยจ่ายค่าปรับ
--     --           งวด2 ยัง unpaid (paid_at is null)
--     select id, installment_no, paid_at, penalty_amount from public.installments
--       where contract_id = '<contract_id>' order by installment_no limit 3;
--     select record_payment_spread('<contract_id>'::uuid, 1500, 300, now(), 'test-qa', null);
--     -- expected: payment_log มีแถวค่าปรับ penalty_paid_amount=300 ผูกกับ installment_id ของ "งวด1"
--     --           (ไม่ใช่งวด2 ที่เป็น unpaid แรก) — เงินต้น 1500 ยังไปตัดงวด2/3 ตามปกติ (penalty_paid_amount=0 ที่แถวนั้น)
--     select installment_id, action, amount, penalty_paid_amount from public.payment_log
--       where contract_id = '<contract_id>' order by created_at desc limit 5;
--   rollback;
--
-- 3) regression: ไม่มีงวดไหนมีค่าปรับค้างเลย (penalty_amount=0 ทุกงวด หรือจ่ายครบแล้ว) → fallback งวด
--    unpaid แรก เหมือนพฤติกรรมเดิม (0079/0113):
--   begin;
--     select record_payment_spread('<contract_id_no_penalty_owed>'::uuid, 1500, 100, now(), 'test-qa', null);
--     select installment_id, penalty_paid_amount from public.payment_log
--       where contract_id = '<contract_id_no_penalty_owed>' order by created_at desc limit 3;
--       -- expected: penalty ลงที่งวด unpaid แรกสุด (installment_no น้อยสุดที่ paid_at is null)
--   rollback;
--
-- 4) penalty-only branch (p_principal=0) ยังทำงานเหมือนเดิมแต่ target เปลี่ยนตามกฎใหม่:
--   begin;
--     select record_payment_spread('<contract_id>'::uuid, 0, 300, now(), 'test-qa', null);
--     select installment_id, penalty_paid_amount, paid_amount_after from public.payment_log
--       where contract_id = '<contract_id>' order by created_at desc limit 1;
--       -- expected: installment_id = งวดที่มีค่าปรับค้างจริง (ไม่ใช่ unpaid แรกเสมอไป)
--       -- installments ของงวดนั้นต้องไม่ถูกแตะ (paid_amount/paid_at/status เดิม)
--   rollback;
--
-- 5) ไม่มีงวดค้างเลย (ทั้งค่าปรับและเงินต้นปิดหมด) → ต้อง error, ห้ามมีแถวใหม่:
--   begin;
--     select record_payment_spread('<contract_id_all_closed>'::uuid, 0, 400, now(), 'test-qa', null);
--     -- expected: ERROR: ไม่มีงวดให้ลงค่าปรับ (ไม่พบงวดที่มีค่าปรับค้างชำระ หรืองวดที่ยังไม่ปิด)
--   rollback;
--
-- 6) fallback block ท้าย function (principal>0 branch, งวดเป้าหมายค่าปรับไม่ได้อยู่ใน loop unpaid เลย
--    เพราะปิดเงินต้นไปแล้ว) — ต้องได้ payment_log 2 แถวขึ้นไป: แถวจากงวดเป้าหมายค่าปรับ (pen เท่านั้น,
--    take=0 ไม่มีในแถวนี้เพราะไม่ได้มาจาก loop) + แถวจาก loop เงินต้นปกติ (penalty_paid_amount=0):
--   begin;
--     select record_payment_spread('<contract_id_penalty_on_closed_installment>'::uuid, 1500, 300, now(), 'test-qa', null);
--     select installment_id, amount, penalty_paid_amount from public.payment_log
--       where contract_id = '<contract_id_penalty_on_closed_installment>' order by created_at desc limit 5;
--   rollback;
--
-- 7) guard เดิมยังทำงาน (ติดลบ / both-zero) — เหมือน 0113 ทุกประการ ไม่เปลี่ยน:
--   begin;
--     select record_payment_spread('<contract_id>'::uuid, -100, 400, now(), 'test-qa', null);
--     -- expected: ERROR: ยอดติดลบไม่ถูกต้อง (เงินต้น=-100, ค่าปรับ=400)
--   rollback;
--   begin;
--     select record_payment_spread('<contract_id>'::uuid, 0, 0, now(), 'test-qa', null);
--     -- expected: ERROR: ไม่มียอดให้บันทึก (เงินต้นและค่าปรับเป็น 0 ทั้งคู่)
--   rollback;
--
-- 8) receipt gate ยังทำงานเหมือนเดิม (v_recorded gate):
--   begin;
--     select count(*) from public.pj_applied_receipts where pj_receipt_uuid = 'test-uuid-0115-qa'; -- baseline ต้อง 0
--     select record_payment_spread(
--       '<contract_id_all_closed>'::uuid, 0, 400, now(), 'test-qa',
--       '[{"uuid":"test-uuid-0115-qa","invoice_no":"TEST-INV","paid_date":"2026-07-18","amount":400,"payment_type":"penalty","source":"review"}]'::jsonb
--     );
--     -- expected: ERROR (เหมือนข้อ 5) — atomic rollback ทั้ง statement
--     select count(*) from public.pj_applied_receipts where pj_receipt_uuid = 'test-uuid-0115-qa'; -- ต้องยังเป็น 0
--   rollback;
--
-- 9) sanity: signature ยังเหลือ 1 ตัวเท่านั้น (ไม่มี overload เพิ่มจากการ CREATE OR REPLACE):
--   SELECT p.pronargs, pg_get_function_identity_arguments(p.oid) AS args
--     FROM pg_proc p WHERE p.proname = 'record_payment_spread' AND p.pronamespace = 'public'::regnamespace;
--   -- expected: 1 row = (uuid, numeric, numeric, timestamptz, text, jsonb)
--
-- 10) verify grant ของ helper ใหม่:
--   select has_function_privilege('service_role', 'public.penalty_paid_for_installment(uuid)', 'execute');
--   -- expected: true
