-- 0147: RPC เก็บ "เฉพาะค่าปรับ" ของงวดที่ค่างวดจ่ายครบแล้ว โดยไม่แตะ installments เลย
--       (ติ๊กจับบั๊ก data-corruption: ปุ่มเดิมเรียก record_payment_with_penalty(p_paid_amount=0) แล้ว
--       ตกเข้า branch v_fully_paid=true เพราะ v_prev_paid+0 >= installment_amount อยู่แล้ว → เขียนทับ
--       installments.paid_at/paid_by_name/status ทุกครั้งที่กด ทำประวัติวันที่จ่ายจริง+ชื่อคนเก็บเดิมเพี้ยน
--       กระทบเมตริกตรงเวลา/ล่าช้าของพนักงาน)
--
-- ============================================================================
-- Convention (ยืนยันจากข้อมูลจริงในระบบ — ดู 0113/0115 penalty-only branch เดิม):
--   payment_log.amount               = ยอดรับจริงครั้งนี้ = ค่าปรับล้วน (ไม่มีเงินต้น) = p_penalty
--   payment_log.penalty_paid_amount  = p_penalty
--   payment_log.paid_amount_after    = installments.paid_amount เดิม "ไม่เปลี่ยน" (เงินต้นไม่ถูกแตะ)
--   installments.*                   ห้ามแตะทุกคอลัมน์ (paid_at, paid_by_name, status, paid_amount,
--                                     penalty_amount) — งวดนี้ค่างวดปิดไปแล้วก่อนหน้า ปุ่มนี้แค่ทยอยเก็บ
--                                     ค่าปรับที่ยังค้างของงวดเดิม ไม่ใช่การชำระงวดใหม่
--
-- Guard:
--   1) p_penalty ต้อง > 0 เท่านั้น (ปฏิเสธ <= 0 ด้วยข้อความไทย)
--   2) งวดไม่พบ → raise exception ข้อความไทย
--   3) กันเก็บเกิน: ยอดค่าปรับสะสมที่เก็บแล้วของงวดนี้ (penalty_paid_for_installment ของ 0115) + p_penalty
--      ต้องไม่เกิน installments.penalty_amount — เกิน raise exception บอกยอดที่เหลือเก็บได้จริง
--
-- ต้นแบบ: 0113/0115 record_payment_spread penalty-only branch — ต่างกันตรงที่ตัวนี้ target
-- installment_id ที่ระบุมาตรงๆ (จากปุ่มในหน้ารายละเอียดสัญญา) แทนการเลือก "งวดค้างเก่าสุด" อัตโนมัติ
-- เพราะ use case นี้คือ staff เห็นงวดที่ต้องการเก็บอยู่ตรงหน้าแล้ว ไม่ต้องให้ระบบเดา
--
-- Additive only — ฟังก์ชันใหม่ทั้งก้อน ไม่แตะ 0040/0113/0115/0127
-- ============================================================================

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

-- GRANT: authenticated (พนักงานกดจากหน้าเว็บ) + service_role (เผื่อเรียกผ่าน Edge Function ในอนาคต)
-- sb_secret_ ไม่มี implicit bypass RLS อีกต่อไป (ดู 0017) — grant execute ให้ชัดเจนตรงนี้
grant execute on function public.record_penalty_only_payment(uuid, numeric, text, timestamptz)
  to authenticated, service_role;

comment on function public.record_penalty_only_payment(uuid, numeric, text, timestamptz) is
  '(0147) เก็บเฉพาะค่าปรับของงวดที่ค่างวดจ่ายครบแล้ว — insert payment_log 1 แถว (action=pay, amount=penalty_paid_amount=p_penalty, paid_amount_after ไม่เปลี่ยน) โดยไม่แตะ installments เลย (แก้บั๊กเดิมที่ record_payment_with_penalty(p_paid_amount=0) เขียนทับ paid_at/paid_by_name/status); guard p_penalty>0 และห้ามเก็บเกิน penalty_amount - penalty_paid_for_installment (0115)';

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — begin/rollback เท่านั้น ห้าม commit จริงตอนทดสอบ
-- ============================================================================

-- a) RPC สร้างสำเร็จ:
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name='record_penalty_only_payment';
-- expected: 1 row

-- b) verify สิทธิ์ execute (กันเจอ 42501 ตอน deploy จริง):
-- select has_function_privilege('authenticated', 'public.record_penalty_only_payment(uuid, numeric, text, timestamptz)', 'EXECUTE');
-- select has_function_privilege('service_role', 'public.record_penalty_only_payment(uuid, numeric, text, timestamptz)', 'EXECUTE');
-- expected: true ทั้งคู่

-- c) หา installment ทดสอบที่ paid_at not null (ค่างวดปิดแล้ว) + penalty_amount > 0 ยังเก็บไม่ครบ:
--   select id, contract_id, paid_at, paid_by_name, status, paid_amount, penalty_amount,
--          public.penalty_paid_for_installment(id) as already_paid
--     from public.installments
--    where paid_at is not null and coalesce(penalty_amount,0) > 0
--    limit 5;

-- d) core: เก็บค่าปรับบางส่วน → installments ต้องไม่เปลี่ยนแม้แต่คอลัมน์เดียว:
--   begin;
--     select paid_at, paid_by_name, status, paid_amount, penalty_amount
--       from public.installments where id = '<installment_id>'; -- baseline
--     select public.record_penalty_only_payment('<installment_id>'::uuid, 100, 'ทดสอบ ครีม');
--     select paid_at, paid_by_name, status, paid_amount, penalty_amount
--       from public.installments where id = '<installment_id>';
--     -- expected: ทุกคอลัมน์เหมือน baseline เป๊ะ (โดยเฉพาะ paid_at, paid_by_name ต้องไม่เปลี่ยน)
--     select action, amount, penalty_paid_amount, paid_amount_after, by_name
--       from public.payment_log where installment_id = '<installment_id>' order by created_at desc limit 1;
--     -- expected: action='pay', amount=100, penalty_paid_amount=100, paid_amount_after=paid_amount เดิม, by_name='ทดสอบ ครีม'
--   rollback;

-- e) guard เก็บเกิน — เกินยอดค้างจริงต้อง error พร้อมบอกยอดที่เหลือ:
--   begin;
--     select public.record_penalty_only_payment('<installment_id>'::uuid, 999999, 'ทดสอบ ครีม');
--     -- expected: ERROR เก็บค่าปรับเกินยอดที่ค้างจริง (เหลือเก็บได้อีก <N> บาท)
--   rollback;

-- f) guard p_penalty <= 0:
--   select public.record_penalty_only_payment('<installment_id>'::uuid, 0, 'ทดสอบ');
--   -- expected: ERROR ยอดค่าปรับต้องมากกว่า 0 บาท: 0
--   select public.record_penalty_only_payment('<installment_id>'::uuid, -50, 'ทดสอบ');
--   -- expected: ERROR ยอดค่าปรับต้องมากกว่า 0 บาท: -50

-- g) งวดไม่มีอยู่จริง:
--   select public.record_penalty_only_payment('00000000-0000-0000-0000-000000000000'::uuid, 100, 'ทดสอบ');
--   -- expected: ERROR ไม่พบงวดผ่อนนี้: 00000000-0000-0000-0000-000000000000

-- h) เก็บจนครบพอดี (p_penalty = v_remaining เป๊ะ) ต้องผ่าน ไม่ error (boundary ไม่ใช่ strict less-than):
--   begin;
--     select public.record_penalty_only_payment('<installment_id_remaining_exact>'::uuid, <remaining_amount>, 'ทดสอบ ครีม');
--     -- expected: ผ่าน ไม่ error
--   rollback;

-- i) sanity: ไม่มี overload ซ้ำ:
--   select p.pronargs, pg_get_function_identity_arguments(p.oid) as args
--     from pg_proc p where p.proname = 'record_penalty_only_payment' and p.pronamespace = 'public'::regnamespace;
--   -- expected: 1 row = (uuid, numeric, text, timestamptz)
