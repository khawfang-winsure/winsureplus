-- 0134: ขยาย RPC ยอดเราให้คืน other_paid (ค่าธรรมเนียม/รายได้อื่นๆ) ต่อสัญญา — แก้ false-positive ถาวรของ
--       pj-sync mode=returned_watch ที่นับ PJ item ประเภท "อื่นๆ" ผิดเป็นค่างวด
--
-- บั๊กต้นเรื่อง (พบ 24 ก.ค. 2026 ตอน sweep ครั้งแรก, ยืนยันซ้ำ prod 29 ก.ค. 2026 — 3 แถวรอตรวจ diff เป๊ะ 500
-- ทุกเคส): mapInvoiceItemRows (pj-sync/index.ts) โยน PJ item ที่ payment_type ไม่ใช่ down/penalty/installment
-- (คือ "อื่นๆ" = ค่าธรรมเนียม/ค่าเปลี่ยนวัน) เข้ากอง pjInstPaidTotal (ค่างวด) แต่ฝั่งเราลงเงินก้อนนี้เป็น
-- other_income ไม่ใช่ค่างวด → diff (pjInst - ourInst) ค้างถาวร ไม่มีทางลดลงเอง → flag ซ้ำเข้ากล่องรอตรวจทุกวัน
-- ทั้งที่เงินไม่ได้หายจริง (ตรวจแล้ว ทั้ง 3 เคสมีแถว other_income 500 บาทบันทึกไว้ครบ):
--   S00025PNQ34 (อานนท์ มาตรสวิง), S00018PNQ032 (ศิรินันท์ อุ่มสาพล), P-JA040044 (สุกัญญา รักสนุก)
--
-- ทางแก้ (คู่กับ pj-sync/index.ts แยกกอง "อื่นๆ" ออกจาก instPaid + เทียบเป็นกองที่ 3 ต่างหาก reason ใหม่
-- RETURNED_CONTRACT_OTHER_FEE) — ฝั่ง DB ต้องมี "ยอด other_income สะสมต่อสัญญา" ให้ Edge Function ดึงมาเทียบ
-- ห่อเป็น RPC ชุดเดียวกับ inst_paid/pen_paid เดิม (returned_watch_our_paid) เพื่อไม่ต้องยิง query แยกอีกรอบ
-- (Edge Function ยิง 1 ครั้งรวมทุกสัญญาเหมือนเดิม กัน N+1 round-trip)
--
-- ต้อง DROP ก่อน CREATE เพราะเปลี่ยน "returns table(...)" (เพิ่มคอลัมน์ other_paid) — พารามิเตอร์ (uuid[])
-- เหมือนเดิมเป๊ะ แต่ Postgres ไม่ยอมให้ CREATE OR REPLACE เปลี่ยน return type ของฟังก์ชันเดิม (error: cannot
-- change return type of existing function) ต้อง drop function ทิ้งก่อนเท่านั้น — เหมือนแพทเทิร์นที่ 0100 เคยทำ
--
-- ⚠️ ห้ามแตะ logic เดิมของ inst_paid/pen_paid เลย (ยังเป็น query เดิมเป๊ะจาก 0125) — เพิ่มแค่ other_paid
-- แยก CTE ต่างหาก (ไม่ join ตรงกับ installments) กันปัญหา cartesian join (ถ้า join other_income เข้ากับ
-- installments ตรงๆ ในคิวรีเดียว sum(i.paid_amount)/sum(penalty_paid_for_installment) จะถูกคูณด้วยจำนวน
-- แถว other_income ของสัญญานั้น — ยอดเงินต้น/ค่าปรับจะเพี้ยนทันที) ใช้ full outer join ระหว่าง 2 CTE
-- ที่ aggregate เสร็จแล้วแทน ปลอดภัยกว่า

drop function if exists public.returned_watch_our_paid(uuid[]);

create or replace function public.returned_watch_our_paid(p_contract_ids uuid[])
returns table(contract_id uuid, inst_paid numeric, pen_paid numeric, other_paid numeric)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with inst as (
    select
      i.contract_id,
      coalesce(sum(i.paid_amount), 0)::numeric as inst_paid,
      coalesce(sum(public.penalty_paid_for_installment(i.id)), 0)::numeric as pen_paid
    from public.installments i
    where i.contract_id = any(p_contract_ids)
    group by i.contract_id
  ),
  other as (
    -- ยอด other_income ทุกแถว ทุกหมวด (ไม่กรอง category/fee_kind — เจตนา: ต้องการยอดรวม "อื่นๆ" ทั้งหมดที่
    -- เราเคยลงไว้บนสัญญานั้น มาเทียบกับกอง pjOtherPaidTotal ฝั่ง PJ แบบก้อนเดียว ไม่ใช่แยกประเภท)
    select
      oi.contract_id,
      coalesce(sum(oi.amount), 0)::numeric as other_paid
    from public.other_income oi
    where oi.contract_id = any(p_contract_ids)
    group by oi.contract_id
  )
  select
    coalesce(inst.contract_id, other.contract_id) as contract_id,
    coalesce(inst.inst_paid, 0)::numeric  as inst_paid,
    coalesce(inst.pen_paid, 0)::numeric   as pen_paid,
    coalesce(other.other_paid, 0)::numeric as other_paid
  from inst
  full outer join other on other.contract_id = inst.contract_id;
$$;

-- grant เดิมเป๊ะจาก 0125 (authenticated, service_role) — function ใหม่ (คนละ object หลัง drop) ต้อง grant ซ้ำ
grant execute on function public.returned_watch_our_paid(uuid[])
  to authenticated, service_role;

comment on function public.returned_watch_our_paid(uuid[]) is
  '(0125, ขยาย 0134) ยอดฝั่งเรารวมต่อสัญญา — เงินต้น sum(installments.paid_amount) + ค่าปรับ cancel-aware sum(penalty_paid_for_installment(id)) + (0134) other_paid = sum(other_income.amount) ทุกแถวทุกหมวด — ใช้โดย pj-sync mode=returned_watch เทียบ 3 กอง (installment/penalty/other) แยกกันกับฝั่ง PJ กัน false-positive ตอน PJ item ประเภท "อื่นๆ" (ค่าธรรมเนียม/ค่าเปลี่ยนวัน) ถูกนับปนกับค่างวด; รับ contract_ids[] คืนหลายแถวในคำสั่งเดียวกัน N+1 RPC จาก Edge Function';

-- ============================================================================
-- Verify (ครีมรันหลัง apply ผ่าน MCP)
-- ============================================================================

-- V1) signature ยังเป็นตัวเดียว คอลัมน์ครบ 4 (contract_id, inst_paid, pen_paid, other_paid):
-- select p.pronargs, pg_get_function_result(p.oid) as ret
--   from pg_proc p where p.proname='returned_watch_our_paid' and p.pronamespace='public'::regnamespace;
-- -- expected: 1 แถว, ret = 'TABLE(contract_id uuid, inst_paid numeric, pen_paid numeric, other_paid numeric)'

-- V2) grant ยังอยู่ครบทั้ง 2 role:
-- select has_function_privilege('service_role', 'public.returned_watch_our_paid(uuid[])', 'execute'); -- true
-- select has_function_privilege('authenticated', 'public.returned_watch_our_paid(uuid[])', 'execute'); -- true

-- V3) sanity เทียบ 3 เคสยืนยันจาก prod (แทน uuid จริงของ อานนท์/ศิรินันท์/สุกัญญา) — other_paid ต้องออกมา
-- >= 500 ทั้ง 3 เคส (มี other_income 500 บันทึกไว้แล้วต่อเคส):
-- select * from public.returned_watch_our_paid(array[
--   '<contract_id อานนท์ S00025PNQ34>'::uuid,
--   '<contract_id ศิรินันท์ S00018PNQ032>'::uuid,
--   '<contract_id สุกัญญา P-JA040044>'::uuid
-- ]);
