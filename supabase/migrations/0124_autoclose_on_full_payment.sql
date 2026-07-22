-- 0124: ปิดสัญญาอัตโนมัติเมื่อจ่ายครบทั้งเงินต้นและค่าปรับ (กันเคสค้าง active ทั้งที่จ่ายจบแล้ว — เจอ 31 เคส 22 ก.ค. 2026 แก้มือไปแล้ว)
--
-- ============================================================================
-- ปัญหา: ระบบไม่มีตัวปิดสัญญาอัตโนมัติเมื่อลูกค้าจ่ายครบ (เงินต้นครบทุกงวด + ค่าปรับครบทุกงวด)
--   ต้องรอ admin ปิดมือ → เจอ 31 สัญญาค้าง status='active' ทั้งที่จ่ายจบไปนานแล้ว (แก้มือไปแล้ว แยกงาน
--   ไม่ backfill ในไฟล์นี้)
--
-- นิยาม "จ่ายครบ" ของสัญญา (ต้องตรงกับที่ใช้ปิด 31 เคสเป๊ะ):
--   ไม่มีงวดไหนที่ยัง "ไม่ครบ" เลย โดยงวดนับว่ายังไม่ครบถ้า:
--     - paid_at is null (เงินต้นยังไม่จ่ายครบ)  หรือ
--     - penalty_amount > penalty_paid_for_installment(id) (ค่าปรับที่เรียกไว้ ยังจ่ายไม่ครบ)
--   penalty_paid_for_installment(uuid) = helper เดิมจาก mig 0115 (sum(payment_log.penalty_paid_amount)
--   where action='pay', reset ที่ cancel ล่าสุด) — ใช้ตัวเดิมตรงๆ ไม่เขียนสูตรใหม่ กันเพี้ยนจาก mirror เดิม
--
-- ============================================================================
-- 🔴 บั๊ก timing ที่เจอก่อน apply (รอบตรวจก่อนขึ้นจริง 22 ก.ค. 2026) — ฉบับเดิมแขวนแค่ trigger เดียว
-- ============================================================================
-- ฉบับแรกแขวน trigger เดียวที่ "AFTER INSERT ON payment_log" โดยคิดว่าครอบทุก path ที่ทำให้ "จ่ายครบ"
-- เกิดขึ้นจริง แต่ไปอ่าน body ของ record_payment_spread (0115) และ record_payment_with_penalty (0040)
-- จริงแล้วพบว่า "ลำดับการเขียนคือ INSERT payment_log ก่อน แล้วค่อย UPDATE installments.paid_at ทีหลัง"
-- ในทรานแซกชันเดียวกัน (ดู 0115 บรรทัด insert payment_log แล้วค่อย update installments ตามหลัง /
-- 0040 เหมือนกันเป๊ะ) — เพราะงั้นตอน trigger "AFTER INSERT ON payment_log" ทำงาน (หลัง insert แถวของ
-- งวดสุดท้าย) installments.paid_at ของงวดนั้น "ยังเป็น null อยู่" (statement UPDATE ยังไม่ถูกรัน) →
-- เงื่อนไข "ทุกงวด paid_at not null" เป็น false เสมอ → เคสหลัก (จ่ายเงินต้นงวดสุดท้ายให้ครบ) จะ
-- "ไม่ถูกปิดอัตโนมัติ" เลย มีแต่เคส penalty-only (ที่ไม่แตะ installments เลย ณ ตอน insert) เท่านั้นที่ทำงาน
-- ถูก — นี่คือ inverse ของเคสส่วนใหญ่จริง (คนจ่ายเงินต้นครบเป็นเคสหลัก ไม่ใช่ penalty-only)
--
-- ทางแก้: แยกเป็น 2 trigger คนละจุดแขวน คนละหน้าที่ ไม่พึ่งพา timing ข้ามสเตทเมนต์กัน:
--   1) AFTER UPDATE OF paid_at ON installments, WHEN (new.paid_at is not null and old.paid_at is null)
--      — จับ "principal completion" (เคสหลัก) ตรงจุดที่ installments.paid_at ถูกเซ็ตแล้วจริง (state ถูก
--      ต้องแน่นอน ไม่ต้องพึ่ง timing ของ statement อื่น) ครอบทั้ง record_payment_spread + record_payment_with_
--      penalty + pj-sync + มือ (ทุก path ที่ UPDATE installments.paid_at null→not null จะโดนจับหมด ไม่ต้อง
--      enumerate ทีละ RPC)
--   2) AFTER INSERT ON payment_log (ของเดิม คงไว้) — จับ "penalty-only completion" (0113 branch) ซึ่งไม่แตะ
--      installments เลย เพราะงั้น trigger บน installments จับไม่ได้ ต้องใช้ payment_log เป็นจุดแขวนแทน
--
-- ทั้งสอง trigger เรียก core function เดียวกัน (autoclose_contract_if_fully_paid) ผ่าน thin wrapper คนละตัว
-- (แยกเพราะ NEW ของ installments ไม่มีคอลัมน์ action → เข้าถึง new.action ตรงๆ จะ runtime error ถ้าใช้
-- function เดียวปนกัน) — core function idempotent + ปลอดภัยเรียกซ้ำได้ทั้งสองทาง
-- ============================================================================
--
-- ข้อบังคับ (money-adjacent):
--   1) ปิดเท่านั้น ห้าม reopen — WHERE status = 'active' เป๊ะ ก่อน UPDATE ไม่แตะ returned/returned_closed/
--      online/closed เดิมเด็ดขาด
--   2) ห้ามแตะเงิน — UPDATE เฉพาะ contracts.status คอลัมน์เดียว ไม่แตะ installments/payment_log/penalty
--   3) ไม่ตั้ง settled_at/case_closed_at — ปิดแบบ "จบปกติ" (status='closed' เฉยๆ) ให้ตรงกับ 195 เคสเดิม
--   4) กันสัญญาไม่มีงวด — exists เช็คมีงวดอย่างน้อย 1 งวด ก่อนจะพิจารณา "ไม่มีงวด non-settled" (ไม่งั้น
--      "ไม่มีงวดค้าง" ของสัญญาที่ยัง generate_installments ไม่เสร็จจะ true แบบผิดๆ)
--   5) ขยายสัญญา (extension) — งวดใหม่ paid_at is null เอง ทำให้เงื่อนไข "ไม่มีงวด non-settled" เป็น false
--      โดยอัตโนมัติ ไม่ต้องเขียนพิเศษ
--
-- Additive only — create or replace function + drop trigger if exists ก่อนสร้างใหม่ ไม่มี DDL ทำลายข้อมูล
-- ============================================================================


-- ============================================================================
-- SECTION 1: Core function — autoclose_contract_if_fully_paid(uuid)
-- ============================================================================
-- SECURITY DEFINER: freelancer/staff caller ไม่มีสิทธิ์ UPDATE contracts.status ตรงๆ (RLS) → function
--   ต้องข้าม RLS ได้ เหมือน clear_promise_on_pay (0029) และ record_payment_spread (0079+)
--
-- ไม่ใช่ trigger function เอง (ไม่มี trigger/NEW ผูกอยู่) — เรียกได้ตรงๆ จาก SQL ด้วยเพื่อ smoke test
-- (เลี่ยงต้อง insert/update จริงผ่าน trigger เวลาต้องการทดสอบ logic core แยกจาก trigger plumbing)
--
-- for update: ล็อกแถว contracts ก่อนเช็คสถานะ กัน race กับ trigger/transaction อื่นที่แก้ status พร้อมกัน
--   (เช่น settle_contract_early ที่ทำงานในทรานแซกชันแยก — ถ้า status ไม่ใช่ 'active' แล้วจะ short-circuit
--   ออกทันที ไม่แตะอะไรต่อ)

create or replace function public.autoclose_contract_if_fully_paid(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.contracts
   where id = p_contract_id
     for update;

  -- ไม่พบสัญญา หรือสถานะไม่ใช่ active → ไม่แตะอะไรเลย (ข้อบังคับ 1: ห้าม reopen/แตะสถานะอื่น)
  if v_status is distinct from 'active' then
    return;
  end if;

  -- ข้อบังคับ 4: ต้องมีงวดอย่างน้อย 1 งวด ก่อนพิจารณา "จ่ายครบ"
  if not exists (
    select 1 from public.installments where contract_id = p_contract_id
  ) then
    return;
  end if;

  -- นิยาม "จ่ายครบ": ไม่มีงวดไหนที่เงินต้นยังไม่จ่าย หรือ ค่าปรับยังจ่ายไม่ครบ
  if not exists (
    select 1
      from public.installments i
     where i.contract_id = p_contract_id
       and (
             i.paid_at is null
          or coalesce(i.penalty_amount, 0) > public.penalty_paid_for_installment(i.id)
       )
  ) then
    -- ข้อบังคับ 2/3: แตะเฉพาะ status คอลัมน์เดียว ไม่ตั้ง settled_at/case_closed_at
    update public.contracts
       set status = 'closed'
     where id = p_contract_id
       and status = 'active';  -- guard ซ้ำ กัน reopen แม้ race condition
  end if;
end;
$$;

comment on function public.autoclose_contract_if_fully_paid(uuid) is
  '(0124) core: ปิดสัญญา active → closed อัตโนมัติเมื่อทุกงวดจ่ายครบทั้งเงินต้น(paid_at not null)และค่าปรับ(penalty_paid_for_installment >= penalty_amount); ปิดเท่านั้นห้าม reopen; ไม่แตะ settled_at/case_closed_at/เงิน; เรียกจาก trigger wrapper 2 ตัว (payment_log insert สำหรับ penalty-only, installments.paid_at update สำหรับ principal completion) — ดู comment หัวไฟล์เรื่องบั๊ก timing ที่แก้';


-- ============================================================================
-- SECTION 2: Trigger wrapper #1 — payment_log AFTER INSERT (จับ penalty-only completion)
-- ============================================================================
-- penalty-only branch (0113 ใน record_payment_spread) ไม่แตะ installments เลย (ตั้งใจ — เงินต้นกับ
-- ค่าปรับคนละมิติ) เพราะงั้นต้องมี trigger แขวนที่ payment_log โดยเฉพาะสำหรับเคสนี้ — ครอบ path มือ
-- (adjust_payment log action='edit' ไม่เข้าเงื่อนไขนี้อยู่แล้ว เพราะเช็ค action='pay' เท่านั้น)

create or replace function public.trg_autoclose_from_payment_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- เฉพาะ action='pay' เท่านั้นที่มีผลต่อยอดจ่ายจริง (edit/cancel ไม่ทำให้ "จ่ายครบ" เกิดขึ้นใหม่)
  if new.action <> 'pay' then
    return new;
  end if;

  perform public.autoclose_contract_if_fully_paid(new.contract_id);

  return new;
end;
$$;

comment on function public.trg_autoclose_from_payment_log() is
  '(0124) trigger wrapper บน payment_log AFTER INSERT — จับ penalty-only completion (ไม่แตะ installments) ที่ trigger ฝั่ง installments จับไม่ได้; action<>pay ข้ามทันที';

drop trigger if exists trg_autoclose_contract_on_full_payment on public.payment_log;
create trigger trg_autoclose_contract_on_full_payment
  after insert on public.payment_log
  for each row execute function public.trg_autoclose_from_payment_log();


-- ============================================================================
-- SECTION 3: Trigger wrapper #2 — installments AFTER UPDATE OF paid_at (จับ principal completion)
-- ============================================================================
-- 🔑 จุดแก้บั๊ก timing: record_payment_spread (0115) และ record_payment_with_penalty (0040) ทั้งคู่ทำ
--   "INSERT payment_log ก่อน แล้วค่อย UPDATE installments.paid_at ทีหลัง" ในทรานแซกชันเดียวกัน — ถ้าแขวน
--   trigger แค่ที่ payment_log อย่างเดียว ตอนงวดสุดท้ายถูก insert log installments.paid_at ของงวดนั้น
--   "ยังเป็น null" (statement UPDATE ยังไม่ถึงคิว) → เช็ค "จ่ายครบ" เป็น false เสมอ เคสหลัก (principal
--   completion) จะไม่ถูกปิดอัตโนมัติเลย
--   แขวนที่ installments เอง หลัง UPDATE ของ statement นั้นทำงานจริงแล้ว (state ถูกต้องแน่นอน ไม่พึ่ง timing
--   ของ statement อื่นในทรานแซกชันเดียวกัน) แก้ปัญหานี้ตรงจุด
--
-- WHEN (new.paid_at is not null and old.paid_at is null) — fire เฉพาะ "transition เป็นจ่ายครบครั้งแรก"
--   กันยิงรัวจาก UPDATE อื่นที่แตะ paid_at คอลัมน์ในเงื่อนไขเดิม (เช่น set paid_at = null ตอนยังไม่ครบ
--   ก็ยังอยู่ใน "UPDATE OF paid_at" แต่ WHEN กรองออกไปเพราะ new.paid_at is null ไม่เข้าเงื่อนไข)
--
-- ทำไมแยก function ไม่ใช้ตัวเดียวกับ payment_log: NEW ของ installments ไม่มีคอลัมน์ action — เข้าถึง
--   new.action ตรงๆ จะ runtime error "record ... has no field action" ถ้าใช้ function เดียวปนกัน

create or replace function public.trg_autoclose_from_installments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  perform public.autoclose_contract_if_fully_paid(new.contract_id);

  return new;
end;
$$;

comment on function public.trg_autoclose_from_installments() is
  '(0124) trigger wrapper บน installments AFTER UPDATE OF paid_at (WHEN null→not null) — จับ principal completion หลัง paid_at ถูกเซ็ตจริงแล้ว แก้บั๊ก timing ของ record_payment_spread/record_payment_with_penalty ที่ insert payment_log ก่อน update installments เสมอ';

drop trigger if exists trg_autoclose_contract_on_installment_paid on public.installments;
create trigger trg_autoclose_contract_on_installment_paid
  after update of paid_at on public.installments
  for each row
  when (new.paid_at is not null and old.paid_at is null)
  execute function public.trg_autoclose_from_installments();


-- ============================================================================
-- SECTION 4: Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — ไม่รันในไฟล์นี้)
-- ⚠️ ทดสอบผ่าน RPC จริง (record_payment_spread / record_payment_with_penalty) เท่านั้น ห้าม manual
--    update+insert เอง — ลำดับ manual จะไม่ตรงกับลำดับจริงของ RPC (insert log ก่อน update installments)
--    ที่เป็นต้นเหตุบั๊ก timing ข้างต้น ต้อง mirror ลำดับจริงถึงจะจับบั๊กเจอ
-- ============================================================================

-- 4a) ตรวจ function + trigger ทั้งคู่มีอยู่:
-- select proname from pg_proc where proname in (
--   'autoclose_contract_if_fully_paid', 'trg_autoclose_from_payment_log', 'trg_autoclose_from_installments'
-- );
--   -- expected: 3 rows
-- select tgname from pg_trigger where tgname in (
--   'trg_autoclose_contract_on_full_payment', 'trg_autoclose_contract_on_installment_paid'
-- );
--   -- expected: 2 rows

-- 4b) นับสัญญา active ที่ "จ่ายครบ" ณ ตอนนี้ (ควรเป็น 0 — 31 เคสถูกปิดมือไปแล้วก่อนหน้านี้):
-- select count(*)
--   from public.contracts c
--  where c.status = 'active'
--    and exists (select 1 from public.installments i where i.contract_id = c.id)
--    and not exists (
--      select 1 from public.installments i
--       where i.contract_id = c.id
--         and (i.paid_at is null
--              or coalesce(i.penalty_amount, 0) > public.penalty_paid_for_installment(i.id))
--    );
-- -- expected: 0

-- 4c) SIMULATE principal completion ผ่าน RPC จริง record_payment_spread (begin/rollback เท่านั้น ห้าม commit):
--     ลำดับภายใน RPC จริงคือ insert payment_log ก่อน แล้วค่อย update installments.paid_at ทีหลัง — นี่คือ
--     path ที่ฉบับเดิม (trigger เดียวบน payment_log) พลาด ต้องผ่านตรงนี้ให้ได้ถึงจะถือว่าแก้บั๊กจริง
-- begin;
--   -- หาสัญญา active ที่ทุกงวดจ่ายครบแล้วยกเว้นงวดสุดท้าย (installment_no มากสุด) ยัง unpaid, penalty=0:
--   select c.id as contract_id
--     from public.contracts c
--    where c.status = 'active'
--      and exists (
--        select 1 from public.installments i where i.contract_id = c.id
--          and i.installment_no = (select max(i2.installment_no) from public.installments i2 where i2.contract_id = c.id)
--          and i.paid_at is null
--      )
--      and not exists (
--        select 1 from public.installments i where i.contract_id = c.id
--          and i.installment_no < (select max(i2.installment_no) from public.installments i2 where i2.contract_id = c.id)
--          and i.paid_at is null
--      )
--    limit 1;
--   -- แทน <contract_id> ด้วยผลลัพธ์ข้างบน:
--   select installment_no, amount, coalesce(paid_amount,0) as paid, penalty_amount
--     from public.installments where contract_id = '<contract_id>'::uuid order by installment_no desc limit 1;
--   -- ยอดที่ต้องจ่ายให้ครบงวดสุดท้าย = amount - paid (สมมติ penalty_amount ของทุกงวด = 0 หรือจ่ายครบแล้ว
--   -- ไม่งั้นต้องส่ง p_penalty คู่ไปด้วยให้ตรง gap)
--
--   select status from public.contracts where id = '<contract_id>'::uuid;
--   -- expected: active (baseline ก่อนยิง RPC)
--
--   select public.record_payment_spread('<contract_id>'::uuid, <ยอด_gap_งวดสุดท้าย>, 0, now(), 'smoke-test-0124-principal', null);
--
--   select status from public.contracts where id = '<contract_id>'::uuid;
--   -- expected: closed  ← ถ้ายังเป็น active = บั๊ก timing ยังไม่ถูกแก้ ห้าม apply ต่อจนกว่าจะ pass ตรงนี้
--
--   -- ไม่มี settled_at/case_closed_at ถูกตั้ง (ถ้าตารางมีคอลัมน์นี้):
--   -- select settled_at, case_closed_at from public.contracts where id = '<contract_id>'::uuid;
--   -- expected: (NULL, NULL) — ไม่เปลี่ยนจากก่อนหน้า
-- rollback;

-- 4d) SIMULATE principal completion ผ่าน RPC record_payment_with_penalty (เส้นทางเดียวกับบั๊ก timing,
--     RPC คนละตัวจาก 4c — ต้อง pass ทั้งคู่):
-- begin;
--   -- หาสัญญา active ที่งวดสุดท้ายเดียวที่เหลือ unpaid (เหมือน 4c) แต่ยิงผ่าน record_payment_with_penalty
--   -- (ทำงานทีละ 1 installment ไม่กระจายหลายงวด — ต้อง installment_id ของงวดสุดท้ายตรงๆ):
--   select public.record_payment_with_penalty(
--     '<installment_id_งวดสุดท้าย>'::uuid, <ยอด_gap>, now(), 'smoke-test-0124-principal2', 0
--   );
--   select status from public.contracts where id = '<contract_id>'::uuid;
--   -- expected: closed
-- rollback;

-- 4e) NEGATIVE TEST: สัญญาที่ยังมีงวดค้าง (paid_at is null หรือค่าปรับยังไม่ครบ) ต้องไม่ถูกปิด — จ่ายงวด
--     ที่ไม่ใช่งวดสุดท้าย ผ่าน record_payment_spread:
-- begin;
--   select status from public.contracts where id = '<contract_id_still_owing>'::uuid; -- baseline: active
--   select public.record_payment_spread('<contract_id_still_owing>'::uuid, 100, 0, now(), 'smoke-test-0124-neg', null);
--   select status from public.contracts where id = '<contract_id_still_owing>'::uuid;
--   -- expected: active (ไม่ถูกปิด เพราะยังมีงวด non-settled อื่นอยู่)
-- rollback;

-- 4f) penalty-only completion ผ่าน record_payment_spread (p_principal=0) — หา contract ที่เงินต้นครบทุก
--     งวดแล้ว เหลือแต่ค่าปรับค้างงวดเดียว เป็น non-settled งวดสุดท้ายของสัญญา:
-- begin;
--   select i.id as installment_id, i.contract_id, i.penalty_amount, public.penalty_paid_for_installment(i.id) as paid_so_far
--     from public.installments i join public.contracts c on c.id = i.contract_id
--    where c.status = 'active' and i.paid_at is not null and i.penalty_amount > 0
--      and public.penalty_paid_for_installment(i.id) < i.penalty_amount
--    limit 1;
--   -- ยิง gap พอดี (penalty_amount - paid_so_far) เป็น penalty-only:
--   select public.record_payment_spread('<contract_id>'::uuid, 0, <gap>, now(), 'smoke-test-0124-penalty', null);
--   select status from public.contracts where id = '<contract_id>'::uuid;
--   -- expected: closed (ถ้านี่คืองวด non-settled สุดท้ายของสัญญา)
-- rollback;

-- 4g) sanity: trigger ไม่แตะ contract ที่ status อื่น (returned/online/closed เดิม) แม้มีการชำระใหม่:
-- begin;
--   select status from public.contracts where id = '<contract_id_returned_status>'::uuid; -- baseline เช่น 'returned'
--   select public.record_payment_spread('<contract_id_returned_status>'::uuid, 100, 0, now(), 'smoke-test-0124-guard', null);
--   select status from public.contracts where id = '<contract_id_returned_status>'::uuid;
--   -- expected: ยังเป็น 'returned' เหมือนเดิม (ไม่ถูก flip เป็น closed หรือสถานะอื่นใด)
-- rollback;

-- 4h) sanity: extension ยังใช้งานปกติ — สัญญาที่เพิ่งขยาย (มีงวดใหม่ paid_at is null) ต้องไม่ถูกปิดแม้จ่าย
--     งวดเก่าครบ (ครอบด้วยเงื่อนไข "ไม่มีงวด non-settled" อยู่แล้วโดยอัตโนมัติ ไม่ต้องเขียนพิเศษ — ทดสอบผ่าน
--     ก่อน apply เพื่อยืนยัน ไม่ใช่แค่ทฤษฎี):
-- begin;
--   select status from public.contracts where id = '<contract_id_extended>'::uuid; -- baseline: active
--   select public.record_payment_spread('<contract_id_extended>'::uuid, <ยอด_งวดเก่าที่เหลือ>, 0, now(), 'smoke-test-0124-ext', null);
--   select status from public.contracts where id = '<contract_id_extended>'::uuid;
--   -- expected: active (งวดใหม่จาก extension ยัง unpaid อยู่ ไม่ถูกปิด)
-- rollback;
