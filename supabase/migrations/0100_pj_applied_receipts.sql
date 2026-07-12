-- 0100: ตารางกันลงซ้ำ PJ Auto-Sync แบบ exact ด้วย receipt uuid (แก้บั๊ก "จ่าย 2 ก้อนวันเดียว ก้อน 2 หาย")
-- เดิม pj_applied_ledger (0080) คีย์กันซ้ำ = (contract_id, pj_paid_date) เท่านั้น — ไม่ดู invoice/ใบเสร็จ
-- → สัญญาเดียวจ่าย 2 ใบเสร็จ (คนละ invoice_no เช่น ค่างวดปัจจุบัน + ค่างวดเก่าที่ตกค้าง) วันเดียวกัน
--   ใบที่ 2 ถูกมองว่า "ลงแล้ว" (เจอ ledger ของ contract_id+paid_date จากใบแรก) → skip เงียบ = เงินหาย
--
-- ตารางนี้คีย์ด้วย pj_receipt_uuid (UUIDv7 ต่อใบเสร็จจริงจาก PJ, field "uuid" ใน receipt JSON — unique
-- ทุกใบ ไม่ซ้ำข้ามใบแม้สัญญา/วันเดียวกัน) แทนคีย์หลวมเดิม → ใบเสร็จคนละใบ ลงได้ทั้งคู่จริง
--
-- ⚠️ ห้ามแตะ/drop pj_applied_ledger — ยังเป็น safety net เดิม (pj-sync ใช้ legacy check
--    (installments.paid_at + ledger) สำหรับใบเสร็จที่ paid_date < cutoff ดูคอมเมนต์ DEDUP_CUTOFF ใน
--    supabase/functions/pj-sync/index.ts)
-- ⚠️ ห้าม backfill ประวัติเข้าตารางนี้ — ใบเสร็จที่ auto-apply ไปแล้วก่อนหน้านี้ไม่เคยเก็บ uuid ไว้
--    (raw_json เก็บ uuid เฉพาะแถวที่เข้ากล่องรอตรวจ ไม่ใช่ทุกใบเสร็จที่ auto-apply) พึ่ง cutoff guard แทน
--
-- ตารางอยู่ใน public.* ได้ default privileges อัตโนมัติจาก 0005 (authenticated) + 0017 (service_role)
-- — ไม่ต้อง grant เพิ่ม เหมือน pattern เดียวกับ pj_applied_ledger (0080). verify ด้วย has_table_privilege
-- ด้านล่างหลัง apply

create table if not exists public.pj_applied_receipts (
  pj_receipt_uuid text        primary key,             -- uuid ดิบจาก PJ (field "uuid" ใน receipt JSON) — 1 แถวต่อ 1 ใบเสร็จจริง
  contract_id     uuid        references public.contracts(id) on delete cascade,  -- align กับ pj_applied_ledger (0080) — ลบสัญญา = ลบประวัติ dedup ของสัญญานั้นไปด้วย ไม่ทิ้ง orphan row
  pj_invoice_no   text,
  pj_paid_date    date,
  amount          numeric     not null default 0,       -- ยอดของใบเสร็จนี้ใบเดียว (ไม่ใช่ยอดรวม agg ต่อ invoice เหมือน pj_applied_ledger)
  payment_type    text,                                 -- installment | penalty | other (ตามที่ PJ ส่งมา)
  source          text        not null default 'auto',  -- 'auto' (cron ลงเอง) | 'review' (พนักงานกดยืนยันจากกล่องรอตรวจ)
  payment_log_id  uuid,                                 -- สำรองไว้อ้างอิง payment_log ในอนาคตถ้า RPC คืน id ได้ — ตอนนี้ยังว่างเสมอ (record_payment_spread ไม่คืนค่า)
  applied_at      timestamptz not null default now()
);

comment on table public.pj_applied_receipts is
  'กันลงซ้ำ PJ Auto-Sync แบบ exact ต่อใบเสร็จ (uuid) — แทนที่ contract-day skip หยาบเดิม ใช้เฉพาะใบเสร็จ paid_date >= DEDUP_CUTOFF (ดู pj-sync/index.ts) คู่กับ pj_applied_ledger เดิมที่ยังใช้ legacy path';
comment on column public.pj_applied_receipts.pj_receipt_uuid is 'uuid ดิบจาก PJ receipt JSON (field "uuid") — UUIDv7 unique ต่อใบเสร็จจริง ไม่ใช่ uuid ที่ Postgres gen เอง';
comment on column public.pj_applied_receipts.amount is 'ยอดของใบเสร็จนี้ใบเดียว (ต่างจาก pj_applied_ledger.inst_amount/pen_amount ที่เป็นยอดรวมต่อวัน)';
comment on column public.pj_applied_receipts.source is 'auto (cron ลงเอง) | review (พนักงานกดยืนยันจากกล่องรอตรวจ — applyPjReviewPayment)';

create index if not exists pj_applied_receipts_contract_id_idx
  on public.pj_applied_receipts(contract_id);
create index if not exists pj_applied_receipts_paid_date_idx
  on public.pj_applied_receipts(pj_paid_date);

-- ============================================================================
-- SECTION 2: RPC record_payment_spread (0079) — เพิ่ม p_receipt_uuids ให้ atomic (ติ๊ก review — RED fix)
--
-- ปัญหาที่แก้: เดิม pj-sync/index.ts เรียก record_payment_spread (คอมมิต payment_log/installments
-- แล้ว) แล้ว INSERT pj_applied_receipts เป็น "transaction แยก" best-effort try/catch เงียบทีหลัง —
-- ถ้า INSERT นั้น fail (เช่น grant ไม่ครบ, network hiccup) → uuid ไม่ถูกจดไว้ → รอบ cron ถัดไป (15 นาที)
-- ไม่เจอ uuid ใน pj_applied_receipts → เข้าใจว่ายังไม่เคยลง → apply RPC ซ้ำ = เงินเบิ้ลจริง (path uuid
-- ตัด safety-net เดิม (installments.paid_at check) ออกไปแล้ว จึงไม่มีอะไรกันซ้ำถ้า write แยกพัง)
--
-- ทางแก้: ย้าย INSERT pj_applied_receipts เข้ามาทำ "ในตัว RPC เดียวกัน" กับการลง payment_log/update
-- installments — เพราะ PL/pgSQL function ทั้งฟังก์ชันรันเป็น atomic operation เดียว (commit/rollback
-- พร้อมกันหมด) เมื่อเรียกผ่าน 1 คำสั่ง RPC เดียว จึงไม่มีทางที่เงินลงแล้วแต่ uuid ไม่ถูกจด (หรือกลับกัน)
--
-- p_receipt_uuids: jsonb array ของ {uuid, invoice_no, paid_date, amount, payment_type, source} — 1
-- element ต่อ 1 ใบเสร็จ (รองรับ 1 invoice มีได้ทั้ง installment+penalty receipt คนละ uuid)
-- default null = ไม่ insert อะไรเข้า pj_applied_receipts เลย (backward compatible กับ caller เดิม)
--
-- Caller เดิมที่ verify แล้ว (grep "record_payment_spread" ทั้ง repo 12 ก.ค. 2026):
--   1) supabase/functions/pj-sync/index.ts — auto-sync (แก้ในรอบนี้ให้ส่ง p_receipt_uuids เมื่อ >= cutoff)
--   2) src/lib/db.ts applyPjReviewPayment — กล่องรอตรวจ (แก้ในรอบนี้ให้ส่ง p_receipt_uuids ด้วย)
--   ไม่มี caller อื่น (paymentSpread.ts เป็น pure-fn จำลอง logic ฝั่ง client เฉยๆ ไม่ได้เรียก RPC จริง)
--   ทั้ง 2 caller เดิมเรียกแบบ named params ผ่าน supabase-js .rpc(...) — resolve เข้า 6-arg ตัวใหม่ถูกต้อง
--   ทั้งคู่ (ส่ง p_receipt_uuids ชัดเจนแล้วในรอบนี้ ไม่ได้พึ่ง default) ไม่มี caller อื่นที่ยังพึ่ง 5-arg เดิม
--
-- ⚠️ ติ๊ก review (RED fix รอบ 2) — ต้อง DROP 5-arg เดิมก่อน CREATE 6-arg ใหม่:
--   Postgres ตัดสิน "identity" ของฟังก์ชันด้วย name + argument-type-list เป๊ะๆ เท่านั้น — การเพิ่ม
--   parameter ใหม่ (แม้มี default) ทำให้ arg-list ยาวขึ้น/ต่างจากเดิม → CREATE OR REPLACE FUNCTION ที่มี
--   arg-list ต่างจากของเดิม **ไม่ได้ replace** ของเดิม แต่สร้าง "overload คนละตัว" แยกออกไป — ของเดิม
--   (5-arg, ไม่มี p_receipt_uuids, ไม่ atomic) ยังอยู่ในฐานเหมือนเดิมทุกประการ ยังถูกเรียกได้จากทุกที่ที่
--   authenticated มีสิทธิ์ execute (SQL editor มือ / สคริปต์ dev ในอนาคต) — ถ้าถูกเรียกจะได้ path ที่ไม่จด
--   pj_applied_receipts เลย (ช่องโหว่ atomicity เดิมกลับมาแบบไม่มี error เตือนใดๆ)
--   แก้ตาม precedent 0091 (can_contact_at 2→3 arg): DROP signature เดิมทิ้งก่อน แล้วค่อย CREATE ใหม่
--   — verify signature 5-arg จริงจาก 0079 แล้ว (อ่านไฟล์ตรงๆ ไม่เดา): (uuid, numeric, numeric,
--   timestamptz, text) ตรงกับพารามิเตอร์ p_contract_id/p_principal/p_penalty/p_paid_at/p_by_name
--   ไม่มี VIEW/TRIGGER/ฟังก์ชันอื่นใน repo อ้าง record_payment_spread ภายใน body ของมันเอง (grep แล้ว —
--   มีแค่ 2 runtime caller ด้านบน) → DROP ปลอดภัย ไม่กระทบ dependency อื่น
-- ============================================================================

drop function if exists public.record_payment_spread(uuid, numeric, numeric, timestamptz, text);

create or replace function public.record_payment_spread(
  p_contract_id    uuid,
  p_principal      numeric,     -- เงินต้นรวมที่ชำระ (ไม่รวมค่าปรับ)
  p_penalty        numeric,     -- ค่าปรับทั้งก้อน (ใส่งวดแรกที่ตัด)
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

    v_last_touched := rec.id;   -- เก็บงวดล่าสุดที่ตัด (เศษเกินจะลงงวดนี้ ให้ตรงกับ client)
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

  -- ── จด pj_applied_receipts ในทรานแซกชันเดียวกับการลงเงินด้านบน (atomic — ติ๊ก review fix) ──────
  --    p_receipt_uuids = null (default) → ข้าม ไม่แตะตารางนี้เลย (caller เดิม/ไม่มี uuid ให้จด)
  --    on conflict do nothing → idempotent ถ้า uuid ซ้ำ (ไม่ error ไม่เบิ้ล แม้เผลอส่งซ้ำ)
  if p_receipt_uuids is not null then
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

-- GRANT: authenticated (พนักงาน) + service_role (Edge Function) เรียกได้
-- เนื่องจาก DROP 5-arg เดิมทิ้งไปแล้วด้านบน ตัวนี้คือฟังก์ชันใหม่จริง (object ใหม่) — สิทธิ์เดิมไม่ถูก
-- carry over มาให้อัตโนมัติ ต้อง grant execute ใหม่เสมอ (ไม่ใช่แค่ "ซ้ำไว้ชัดเจน" เหมือนที่เข้าใจผิดตอนแรก)
grant execute on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb)
  to authenticated, service_role;

comment on function public.record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb) is
  'ตัดยอดชำระกระจายหลายงวดตามลำดับ installment_no — ค่าปรับใส่งวดแรกเท่านั้น; เศษที่เกินบวกทับงวด unpaid ตัวท้ายที่เพิ่งตัด (ตรง client paymentSpread.ts) fallback งวดสุดท้ายถ้าไม่มีงวด unpaid; p_receipt_uuids (0100) จด pj_applied_receipts แบบ atomic ในทรานแซกชันเดียวกัน ถ้าไม่ null';

-- ============================================================================
-- Verify (ครีม/ติ๊กรันหลัง apply — comment ไว้ ไม่รันอัตโนมัติ):
-- ============================================================================
-- select has_table_privilege('service_role', 'public.pj_applied_receipts', 'SELECT'); -- ต้อง true
-- select has_table_privilege('service_role', 'public.pj_applied_receipts', 'INSERT'); -- ต้อง true
-- select has_table_privilege('authenticated', 'public.pj_applied_receipts', 'INSERT'); -- ต้อง true (applyPjReviewPayment เขียนผ่าน authenticated)
-- select relname, rowsecurity from pg_class where relname = 'pj_applied_receipts'; -- rowsecurity=false ตั้งใจ (เหมือน pj_applied_ledger 0080 — ไม่มี policy, คุมผ่าน db.ts/Edge Function เท่านั้น)
-- select pg_get_functiondef('public.record_payment_spread(uuid,numeric,numeric,timestamptz,text,jsonb)'::regprocedure); -- เช็ค signature ใหม่
-- select has_function_privilege('service_role', 'public.record_payment_spread(uuid,numeric,numeric,timestamptz,text,jsonb)', 'execute'); -- ต้อง true
-- -- atomic proof: เรียก RPC ด้วย p_receipt_uuids ที่มี uuid ปลอม 1 ตัว แล้วบังคับ error (เช่น p_contract_id ผิด)
-- -- ต้องไม่มีทั้ง payment_log และ pj_applied_receipts ถูกเขียน (rollback พร้อมกันทั้งคู่)
--
-- 🚨 ติ๊ก review (RED fix รอบ 2) — verify record_payment_spread เหลือ "1 signature" เท่านั้น (6-arg)
--    ไม่มี 5-arg เดิมตกค้าง (pattern เดียวกับ 0091 SECTION 5b สำหรับ can_contact_at):
-- SELECT p.pronargs, pg_get_function_identity_arguments(p.oid) AS args
--   FROM pg_proc p
--  WHERE p.proname = 'record_payment_spread' AND p.pronamespace = 'public'::regnamespace;
-- -- expected: 1 row เท่านั้น = record_payment_spread(uuid, numeric, numeric, timestamptz, text, jsonb)
-- -- ถ้าเจอ 2 แถว (มี 5-arg โผล่มาด้วย) = DROP ด้านบนไม่ทำงาน/apply ไม่ครบ ต้องสอบสวนก่อนปล่อยให้ cron วิ่งต่อ
