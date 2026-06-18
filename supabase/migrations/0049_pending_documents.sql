-- 0049: เพิ่มสถานะ "รอเอกสาร/Case Online" (pending_documents) บนสัญญา
-- เมื่อ pending_documents = true → ระบบ suppress สถานะล่าช้าทั้งหมดจนกว่าจะยืนยัน
-- Pete เคาะ confirm-gate model 19 มิ.ย. 2026

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์บนตาราง contracts
-- ============================================================================

-- 1a) flag หลัก — NOT NULL DEFAULT false เพราะสัญญาเก่าทุกอันถือว่า "ไม่ได้รอเอกสาร"
alter table public.contracts
  add column if not exists pending_documents boolean not null default false;

-- 1b) audit cols — nullable (ยังไม่ได้ยืนยัน = null)
--   pattern เดียวกับ email_sent_at/email_sent_by (0025)
alter table public.contracts
  add column if not exists documents_confirmed_at  timestamptz,
  add column if not exists documents_confirmed_by  text;

-- ============================================================================
-- SECTION 2: CREATE OR REPLACE VIEW v_contract_status
--
-- reproduce ทุก column จาก 0024 ครบถ้วน + เพิ่มเงื่อนไข pending_documents
--   - column set: contract_id, contract_no, customer_name, shop_id, shop_name,
--                 status, next_due, remaining_installments, penalty_due,
--                 days_late, bucket, grade, est_outstanding  (13 columns — เท่าเดิม)
--   - pending_documents = true → days_late = 0, bucket = 'normal'
--     (วางเป็น CASE arm แรกสุด ก่อน logic late ปกติ เพื่อ short-circuit)
--   - security_invoker = on คงไว้ (critical สำหรับ freelancer RLS — จาก 0018)
--   - JOIN shops_basic ไม่ใช่ shops (จาก 0018 Fix 4)
--
-- หมายเหตุ: CREATE OR REPLACE ใช้ได้เพราะไม่เปลี่ยน column set
--   ถ้า Postgres ปฏิเสธ (เช่น reloptions conflict) ให้ DROP+CREATE แทน
--   แต่ pattern ที่ migrate 0024 ใช้คือ drop+create ดังนั้นทำเหมือนกันเพื่อความปลอดภัย
-- ============================================================================

drop view if exists public.v_contract_status;

create view public.v_contract_status
  with (security_invoker = on) as
with agg as (
  select
    i.contract_id,
    min(i.due_date) filter (where i.paid_at is null) as next_due,
    coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0) as penalty_due,
    count(*) filter (where i.paid_at is null) as remaining_installments
  from installments i
  group by i.contract_id
)
select
  c.id                                              as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name                                            as shop_name,
  c.status,
  a.next_due,
  coalesce(a.remaining_installments, 0)             as remaining_installments,
  coalesce(a.penalty_due, 0)                        as penalty_due,
  -- days_late: suppress เป็น 0 เมื่อรอเอกสาร (pending_documents)
  case
    when c.pending_documents = true               then 0
    when c.status <> 'active' or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end                                               as days_late,
  -- bucket: suppress เป็น 'normal' เมื่อรอเอกสาร
  case
    when c.pending_documents = true               then 'normal'
    when c.status <> 'active' or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10          then '1-10'
    when current_date - a.next_due <= 30          then '11-30'
    when current_date - a.next_due <= 60          then '31-60'
    when current_date - a.next_due <= 90          then '61-90'
    when current_date - a.next_due <= 120         then '91-120'
    else '120+'
  end                                               as bucket,
  -- grade: reproduce pattern เดียวกับ 0024 (ใช้ days_late ที่คำนวณแล้ว)
  grade_for_days_late(
    case
      when c.pending_documents = true               then 0
      when c.status <> 'active' or a.next_due is null then 0
      else greatest(0, (current_date - a.next_due))
    end
  )                                                 as grade,
  -- est_outstanding: จาก 0024 — ไม่เปลี่ยน
  coalesce(c.monthly_payment, 0) * coalesce(a.remaining_installments, 0) as est_outstanding
from contracts c
left join agg a         on a.contract_id = c.id
left join shops_basic s on s.id = c.shop_id;

-- restore grants (drop view loses all privileges — pattern จาก 0018 §7 และ 0024)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;

-- ============================================================================
-- SECTION 3: Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- 3a) column pending_documents มีอยู่ + ค่า default ถูก:
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'contracts'
--     AND column_name IN ('pending_documents','documents_confirmed_at','documents_confirmed_by');
-- expected: 3 rows — pending_documents boolean NOT NULL DEFAULT false,
--           documents_confirmed_at timestamptz nullable, documents_confirmed_by text nullable

-- 3b) view มีครบ 13 columns (ไม่ตกหล่น):
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'v_contract_status'
--   ORDER BY ordinal_position;
-- expected: contract_id, contract_no, customer_name, shop_id, shop_name,
--           status, next_due, remaining_installments, penalty_due,
--           days_late, bucket, grade, est_outstanding

-- 3c) security_invoker ยังคงเปิด:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- expected: เห็น security_invoker=on ใน reloptions

-- 3d) grants ครบ:
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role', 'public.v_contract_status', 'SELECT');
-- expected: true ทั้งคู่

-- 3e) smoke: สัญญาที่ pending_documents=true ต้อง days_late=0 และ bucket='normal'
-- SELECT contract_id, days_late, bucket
--   FROM public.v_contract_status
--   WHERE contract_id IN (
--     SELECT id FROM public.contracts WHERE pending_documents = true LIMIT 5
--   );
-- expected: days_late=0, bucket='normal' ทุกแถว

-- 3f) service_role access บนตาราง contracts ยังทำงาน (ไม่กระทบจาก alter add column):
-- SELECT has_table_privilege('service_role', 'public.contracts', 'SELECT');
-- expected: true (จาก 0017 ALTER DEFAULT PRIVILEGES)
