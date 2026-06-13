-- 0029: ล้าง promise_to_pay_date + promised_amount เมื่อจ่าย (action='pay') กัน priority เพี้ยน
-- เมื่อมี payment_log INSERT (action='pay') → ล้าง contracts.promise_to_pay_date + promised_amount
-- (ลูกค้าจ่ายแล้ว = สัญญาเก่า fulfilled, ระบบไม่ควร track ต่อ)
-- ถ้าฟรีแลนซ์อยากให้ลูกค้าสัญญารอบใหม่ → record follow_up='promised' ใหม่ → trigger sync_promise_to_pay ตั้งใหม่

-- ============================================================================
-- SECTION 1: Function — clear_promise_on_pay
-- ============================================================================
-- SECURITY DEFINER: freelancer ไม่มี contracts_write RLS → trigger ต้องข้าม RLS ได้
-- (เหตุผลเดียวกับ sync_promise_to_pay ใน 0020)
--
-- guard: where promise_to_pay_date is not null
--   → ไม่ UPDATE contracts ที่ไม่มี promise (ลด trigger overhead)
--
-- หมายเหตุ: record_payment (0011) insert action='pay' ทั้งจ่ายครบ + จ่ายบางส่วน
--   ดังนั้น trigger นี้จะล้าง promise แม้จ่ายบางส่วน
--   (ยังถือว่าถูกต้อง — lateness signal ยังคำนวณจาก daysLate ตาม view v_contract_status,
--    ฟรีแลนซ์ที่ต้องการติดตามรอบใหม่สามารถ record follow_up='promised' อีกครั้งได้)
--
-- หมายเหตุ: action='edit' (adjust_payment) ไม่ล้าง promise
--   เพราะ adjust_payment log ด้วย action='edit' ไม่ใช่ 'pay' → guard ป้องกันแล้ว
--
-- หมายเหตุ: view v_promise_attribution_30d (0023) ไม่ได้อ่าน contracts.promise_to_pay_date
--   → อ่านจาก follow_ups + payment_log history แทน → credit freelancer ปลอดภัย ไม่กระทบ

create or replace function public.clear_promise_on_pay()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.action = 'pay' then
    update public.contracts
       set promise_to_pay_date = null,
           promised_amount     = null
     where id = new.contract_id
       and promise_to_pay_date is not null;
  end if;
  return new;
end;
$$;

-- ============================================================================
-- SECTION 2: Trigger — trg_clear_promise_on_pay on payment_log
-- ============================================================================
-- AFTER INSERT: รันหลัง set_payment_log_actor (BEFORE INSERT) เสมอ
-- ชื่อ trigger 'trg_c' → alphabetically หลัง trigger อื่นบน payment_log (ถ้ามี)

drop trigger if exists trg_clear_promise_on_pay on public.payment_log;
create trigger trg_clear_promise_on_pay
  after insert on public.payment_log
  for each row execute function public.clear_promise_on_pay();

-- ============================================================================
-- SECTION 3: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 3a) ตรวจ trigger มีอยู่:
-- SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_clear_promise_on_pay';
--   expected: 1

-- 3b) ตรวจ function มีอยู่:
-- SELECT proname FROM pg_proc WHERE proname = 'clear_promise_on_pay';
--   expected: 1 row

-- 3c) trigger fire probe (ล้อมใน transaction แล้ว ROLLBACK เพื่อไม่เปลี่ยน data จริง):
-- BEGIN;
--   UPDATE public.contracts
--      SET promise_to_pay_date = '2026-06-30', promised_amount = 5000
--    WHERE id = '<test-contract-id>';
--   -- ยืนยันตั้งค่าแล้ว:
--   SELECT promise_to_pay_date, promised_amount FROM public.contracts WHERE id = '<test-contract-id>';
--   -- expected: ('2026-06-30', 5000)
--
--   INSERT INTO public.payment_log (contract_id, action, amount, paid_amount_after, note)
--     VALUES ('<test-contract-id>', 'pay', 1000, 1000, 'smoke test 0029');
--   -- ยืนยัน trigger ล้างแล้ว:
--   SELECT promise_to_pay_date, promised_amount FROM public.contracts WHERE id = '<test-contract-id>';
--   -- expected: (NULL, NULL)
-- ROLLBACK;

-- 3d) ตรวจ action='edit' ไม่ล้าง (negative case):
-- BEGIN;
--   UPDATE public.contracts
--      SET promise_to_pay_date = '2026-06-30', promised_amount = 5000
--    WHERE id = '<test-contract-id>';
--   INSERT INTO public.payment_log (contract_id, action, amount, paid_amount_after, note)
--     VALUES ('<test-contract-id>', 'edit', 1000, 1000, 'smoke negative 0029');
--   SELECT promise_to_pay_date, promised_amount FROM public.contracts WHERE id = '<test-contract-id>';
--   -- expected: ('2026-06-30', 5000) ← ไม่ถูกล้าง
-- ROLLBACK;

-- 3e) ตรวจ contracts ที่ไม่มี promise ไม่ถูก UPDATE (overhead guard):
-- EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM public.contracts WHERE promise_to_pay_date IS NOT NULL;
-- (ดูว่า index scan เร็ว หรือ seq scan — เป็น informational เท่านั้น ไม่ใช่ pass/fail)
