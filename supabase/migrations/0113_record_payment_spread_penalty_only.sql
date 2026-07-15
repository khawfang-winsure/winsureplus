-- 0113: แก้บั๊ก record_payment_spread ทิ้งค่าปรับเงียบเมื่อเงินต้น=0 (เงินหายถาวร — ลักขณา S00003PNQ118 400บ.)
--
-- ============================================================================
-- บั๊กเดิม (0079 body, inherit ผ่าน 0100):
--   p_principal=0, p_penalty=400 → take := least(gap, v_rem)=least(gap,0)=0 ทุกงวด
--   → continue when take <= 0 ยิงทุกงวด (ไม่เคยเข้า body ที่ insert payment_log)
--   → จบ loop, v_rem(=0) ไม่ > 0 → ข้าม overpay fallback ด้วย
--   → payment_log 0 แถว (ค่าปรับหายเงียบ ไม่ error) แต่ pj_applied_receipts insert ท้าย function
--     ทำงานแบบไม่มีเงื่อนไข (if p_receipt_uuids is not null เท่านั้น) → uuid ถูกจดว่า "ลงแล้ว"
--     ทั้งที่เงินไม่เคยลง → cron ไม่หยิบมาลงอีกตลอดกาล = เงินหายถาวร
--
-- ทางแก้ (แบมสเปค):
--   1) guard ยอดติดลบ (เช็คก่อนอย่างอื่น) → raise exception (ติ๊กจับ 16 ก.ค.: p_principal ติดลบ + p_penalty
--      บวก ผ่าน guard both-zero เดิมได้ แล้วตกลงไป penalty-only branch แบบเงียบ = ค่าติดลบถูกทิ้งไม่มี
--      คำเตือน บั๊กพันธุ์เดียวกับที่กำลังแก้อยู่ในไฟล์นี้ — root cause ฝั่ง UI คือ PjSyncReview.tsx input
--      number ไม่มี min="0" ปล่อยให้กรอกติดลบได้ ฝั่ง UI แก้แยกโดยน้องวิว ฝั่ง RPC กันไว้ชั้นสุดท้ายที่นี่)
--   2) guard ทั้งสองยอด <= 0 → raise exception (กันเรียกมั่ว)
--   3) branch พิเศษ p_principal<=0 and p_penalty>0 → ลง payment_log 1 แถวที่งวดค้างที่เก่าสุด
--      (ไม่แตะ installments เพราะเงินต้นไม่ถูกจ่าย — ตามนิยาม)
--      ไม่มีงวดค้าง → raise exception ห้ามแตะ payment_log/pj_applied_receipts เลย
--   4) branch เดิม (p_principal>0) logic ไม่เปลี่ยน — track ตัวแปร v_recorded ว่ามีการลง payment_log จริง
--   5) 🔴 receipt gate: จด pj_applied_receipts เฉพาะเมื่อ v_recorded=true เท่านั้น — นี่คือส่วนที่ปิดช่องเงินหายถาวร
--
-- Signature เดิมเป๊ะ (ไม่เปลี่ยน) — CREATE OR REPLACE ตรงๆ พอ ไม่ต้อง DROP เพราะ arg-list ไม่เปลี่ยน:
--   record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb)
-- caller ที่ใช้ signature นี้อยู่แล้ว ไม่ต้องแก้: src/lib/db.ts applyPjReviewPayment,
-- supabase/functions/pj-sync/index.ts — ทั้งคู่เรียกแบบ named params ผ่าน .rpc(...)
-- ============================================================================

create or replace function public.record_payment_spread(
  p_contract_id    uuid,
  p_principal      numeric,     -- เงินต้นรวมที่ชำระ (ไม่รวมค่าปรับ)
  p_penalty        numeric,     -- ค่าปรับทั้งก้อน (ใส่งวดแรกที่ตัด / หรืองวดค้างเก่าสุดถ้าเป็น penalty-only)
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
  v_first    boolean;   -- flag: งวดแรกที่ตัด (ใส่ค่าปรับที่นี่)
  v_recorded boolean := false;  -- (0113) true เมื่อมีการ insert payment_log จริงอย่างน้อย 1 แถว — gate ให้ pj_applied_receipts
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
  -- (0113) ตัวแปรสำหรับ penalty-only branch
  v_ref_id   uuid;
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

  if p_principal <= 0 and p_penalty > 0 then
    -- ============================================================================
    -- (0113) PENALTY-ONLY BRANCH — เงินต้น=0 มีแต่ค่าปรับ (บั๊กเดิม: loop เงินต้นไม่เคยรัน body
    -- เพราะ take=least(gap,0)=0 ทุกงวด → ค่าปรับหายเงียบ) ข้าม loop เงินต้นทั้งหมด ลงค่าปรับตรงที่
    -- งวดค้างเก่าสุดแทน — ไม่แตะ installments (paid_amount/paid_at/status/paid_by_name) เพราะเงินต้น
    -- ไม่ถูกจ่ายตามนิยาม (ตรงกับกฎค่าปรับครั้งเดียว/งวดเก่าสุด ใน 0031 run_daily_update)
    -- ⚠️ order by installment_no อาจ ≠ ลำดับ due_date จริงในสัญญาที่ขยายเวลา (inherit จาก loop เดิม
    --    ด้านล่าง ไม่ใช่บั๊กใหม่ที่เพิ่มตอนนี้ — กันคนมาแก้ผิดทีหลัง)
    -- ============================================================================
    select id, coalesce(paid_amount, 0)
      into v_ref_id, v_ref_paid
      from public.installments
     where contract_id = p_contract_id
       and paid_at is null
     order by installment_no
     limit 1;

    if not found then
      -- ไม่มีงวดค้างให้ลงค่าปรับ (สัญญาปิดแล้ว/ไม่มีงวดเปิด) → ห้ามแตะ payment_log/pj_applied_receipts เลย
      raise exception 'ไม่มีงวดค้างชำระให้ลงค่าปรับ (สัญญานี้ไม่มีงวดที่ยังเปิดอยู่)';
    end if;

    insert into public.payment_log (
      installment_id,
      contract_id,
      action,
      amount,               -- ยอดรับจริง = ค่าปรับล้วน (ไม่มีเงินต้น)
      paid_amount_after,    -- principal สะสม "ไม่เปลี่ยน" — เงินต้นไม่ถูกแตะ
      penalty_paid_amount,
      by_name
    ) values (
      v_ref_id,
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
    -- PRINCIPAL > 0 BRANCH — logic เดิมจาก 0079/0100 ไม่เปลี่ยน มีแค่ track v_recorded เพิ่ม
    -- ============================================================================
    v_rem   := p_principal;
    v_first := true;

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

      v_last_touched := rec.id;   -- เก็บงวดล่าสุดที่ตัด (เศษเกินจะลงงวดนี้ ให้ตรงกับ client)
      v_rem   := v_rem - take;
      v_first := false;
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
  end if;

  -- ── จด pj_applied_receipts ในทรานแซกชันเดียวกับการลงเงินด้านบน (atomic — 0100) ──────────────────
  --    p_receipt_uuids = null (default) → ข้าม ไม่แตะตารางนี้เลย (caller เดิม/ไม่มี uuid ให้จด)
  --    on conflict do nothing → idempotent ถ้า uuid ซ้ำ (ไม่ error ไม่เบิ้ล แม้เผลอส่งซ้ำ)
  --    🔴 (0113) เพิ่ม "and v_recorded" — ถ้า branch ข้างบนไม่ได้ลง payment_log จริงเลย (เช่นบั๊กเดิม
  --    penalty ถูกทิ้งเงียบ) ต้องไม่จด pj_applied_receipts เด็ดขาด ไม่งั้น cron จะเข้าใจว่า "ลงแล้ว"
  --    ทั้งที่เงินไม่เคยเข้าระบบ = เงินหายถาวร (นี่คือ root cause ของบั๊กที่แก้ในรอบนี้)
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
  'ตัดยอดชำระกระจายหลายงวดตามลำดับ installment_no — ค่าปรับใส่งวดแรกเท่านั้น; เศษที่เกินบวกทับงวด unpaid ตัวท้ายที่เพิ่งตัด (ตรง client paymentSpread.ts) fallback งวดสุดท้ายถ้าไม่มีงวด unpaid; p_receipt_uuids (0100) จด pj_applied_receipts แบบ atomic เฉพาะเมื่อมีการลง payment_log จริง (v_recorded, 0113); (0113) p_principal<=0 and p_penalty>0 = penalty-only branch ลงค่าปรับที่งวดค้างเก่าสุดโดยไม่แตะ installments; ทั้งสองยอด<=0 หรือ penalty-only ไม่มีงวดค้าง → raise exception แทนเงียบ; (0113 ติ๊กจับ) p_principal หรือ p_penalty ติดลบ → raise exception ทันที (กันติดลบหลุดเข้า penalty-only branch แบบเงียบ)';

-- ============================================================================
-- Verify (ครีมรันหลัง apply — begin/rollback เท่านั้น ห้าม commit จริงตอนทดสอบ):
-- ============================================================================
--
-- 0) หา contract_id ทดสอบที่มีงวดค้างอยู่จริง (ยังไม่จ่าย) — แทนที่ '<contract_id>' ด้านล่างด้วยของจริง
--
-- 1) penalty-only ต้องได้ 1 แถว payment_log ใหม่ + installments ไม่ถูกแตะ:
--   begin;
--     select count(*) from public.installments where contract_id = '<contract_id>' and paid_at is null; -- เก็บ baseline
--     select count(*) from public.payment_log where contract_id = '<contract_id>'; -- เก็บ baseline
--     select record_payment_spread('<contract_id>'::uuid, 0, 400, now(), 'test-qa', null);
--     select count(*) from public.payment_log where contract_id = '<contract_id>'; -- ต้อง +1 จาก baseline
--     select amount, penalty_paid_amount, paid_amount_after from public.payment_log
--       where contract_id = '<contract_id>' order by created_at desc limit 1;
--       -- expected: amount=400, penalty_paid_amount=400, paid_amount_after = paid_amount เดิมของงวดอ้างอิง (ไม่เปลี่ยน)
--     select paid_amount, paid_at, status from public.installments
--       where contract_id = '<contract_id>' and paid_at is null order by installment_no limit 1;
--       -- expected: ไม่เปลี่ยนจาก baseline (เงินต้น/paid_at/status เดิมเป๊ะ)
--   rollback;
--
-- 2) สัญญาไม่มีงวดค้าง (ทุกงวด paid_at not null) + penalty-only → ต้อง error, ห้ามมีแถวใหม่:
--   begin;
--     select record_payment_spread('<contract_id_all_paid>'::uuid, 0, 400, now(), 'test-qa', null);
--     -- expected: ERROR: ไม่มีงวดค้างชำระให้ลงค่าปรับ (สัญญานี้ไม่มีงวดที่ยังเปิดอยู่)
--   rollback;
--
-- 3) ทั้งสองยอด <= 0 → ต้อง error:
--   begin;
--     select record_payment_spread('<contract_id>'::uuid, 0, 0, now(), 'test-qa', null);
--     -- expected: ERROR: ไม่มียอดให้บันทึก (เงินต้นและค่าปรับเป็น 0 ทั้งคู่)
--   rollback;
--
-- 3b) (ติ๊กจับ 16 ก.ค.) p_principal ติดลบ + p_penalty บวก → ต้อง error ทันที ก่อนแตะ guard both-zero
--     (กันหลุดเข้า penalty-only branch แบบเงียบ):
--   begin;
--     select record_payment_spread('<contract_id>'::uuid, -100, 400, now(), 'test-qa', null);
--     -- expected: ERROR: ยอดติดลบไม่ถูกต้อง (เงินต้น=-100, ค่าปรับ=400)
--     select count(*) from public.payment_log where contract_id = '<contract_id>'; -- ต้องไม่เปลี่ยนจาก baseline
--   rollback;
--
-- 3c) p_penalty ติดลบเดี่ยวๆ ก็ต้อง error เหมือนกัน:
--   begin;
--     select record_payment_spread('<contract_id>'::uuid, 500, -50, now(), 'test-qa', null);
--     -- expected: ERROR: ยอดติดลบไม่ถูกต้อง (เงินต้น=500, ค่าปรับ=-50)
--   rollback;
--
-- 4) receipt gate ไม่จดตอน error (ทดสอบด้วย p_receipt_uuids ไม่ null คู่กับ error case 2 หรือ 3):
--   begin;
--     select count(*) from public.pj_applied_receipts where pj_receipt_uuid = 'test-uuid-0113-qa'; -- baseline ต้อง 0
--     select record_payment_spread(
--       '<contract_id_all_paid>'::uuid, 0, 400, now(), 'test-qa',
--       '[{"uuid":"test-uuid-0113-qa","invoice_no":"TEST-INV","paid_date":"2026-07-16","amount":400,"payment_type":"penalty","source":"review"}]'::jsonb
--     );
--     -- expected: ERROR (เหมือนข้อ 2) — exception ทำให้ทั้ง statement rollback อัตโนมัติอยู่แล้ว (atomic)
--     select count(*) from public.pj_applied_receipts where pj_receipt_uuid = 'test-uuid-0113-qa'; -- ต้องยังเป็น 0 (ไม่เคยถูก insert เพราะ exception มาก่อนถึงบรรทัดนั้น)
--   rollback;
--
-- 5) regression: principal>0 ปกติ (มี+ไม่มี penalty) ยังทำงานเหมือนเดิม — เทียบผลกับพฤติกรรมก่อน 0113:
--   begin;
--     select record_payment_spread('<contract_id>'::uuid, 1500, 100, now(), 'test-qa', null);
--     select * from public.payment_log where contract_id = '<contract_id>' order by created_at desc limit 3;
--   rollback;
--
-- 6) sanity: signature ยังเหลือ 1 ตัวเท่านั้น (ไม่มี overload เพิ่มจากการ CREATE OR REPLACE):
--   SELECT p.pronargs, pg_get_function_identity_arguments(p.oid) AS args
--     FROM pg_proc p WHERE p.proname = 'record_payment_spread' AND p.pronamespace = 'public'::regnamespace;
--   -- expected: 1 row = (uuid, numeric, numeric, timestamptz, text, jsonb)
