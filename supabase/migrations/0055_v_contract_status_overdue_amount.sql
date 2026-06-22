-- 0055: เพิ่ม overdue_amount บน v_contract_status (ยอดงวดที่เลยกำหนด รองรับหน้าจดหมาย)
-- ปัญหาเดิม: หน้า Letters.tsx คำนวณยอดค้างจาก installments ที่ติด PAGE_CAP 4,999
--           → overdueCount=0 สำหรับสัญญาที่งวดหลุดเกิน cap → แสดงแค่ค่าปรับ
-- แก้โดย: ย้ายการคำนวณมาฝั่ง DB ใน CTE agg → overdue_amount พร้อมใช้ใน view ตรงๆ
-- ฟิลด์ใหม่ (ต่อท้าย est_outstanding — CREATE OR REPLACE append-only):
--   overdue_amount = sum(amount - paid_amount) งวดที่ยังไม่ชำระ และ due_date <= today
--                  suppress เป็น 0 เมื่อ pending_documents=true หรือ status<>'active'
--                  (ตรงกับ logic days_late ปัจจุบัน)
--
-- หมายเหตุด้าน security: ใช้ CREATE OR REPLACE เพื่อคง grant + security_invoker=on
--   (freelancer RLS ต้องการ security_invoker=on — จาก 0018, คง grant จาก 0049)

create or replace view public.v_contract_status
  with (security_invoker = on) as
with agg as (
  select
    i.contract_id,
    min(i.due_date) filter (where i.paid_at is null)                        as next_due,
    coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0)     as penalty_due,
    count(*) filter (where i.paid_at is null)                               as remaining_installments,
    -- ยอดงวดที่เลยกำหนดและยังไม่ชำระ (principal คงค้าง = amount - paid_amount)
    coalesce(
      sum(i.amount - coalesce(i.paid_amount, 0))
        filter (where i.paid_at is null and i.due_date <= current_date),
      0::numeric
    )                                                                        as overdue_principal
  from installments i
  group by i.contract_id
)
select
  c.id                                                                       as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name                                                                     as shop_name,
  c.status,
  a.next_due,
  coalesce(a.remaining_installments, 0)                                      as remaining_installments,
  coalesce(a.penalty_due, 0)                                                 as penalty_due,
  -- days_late: suppress เป็น 0 เมื่อรอเอกสาร (pending_documents)
  case
    when c.pending_documents = true                then 0
    when c.status <> 'active' or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end                                                                        as days_late,
  -- bucket: suppress เป็น 'normal' เมื่อรอเอกสาร
  case
    when c.pending_documents = true                then 'normal'
    when c.status <> 'active' or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10           then '1-10'
    when current_date - a.next_due <= 30           then '11-30'
    when current_date - a.next_due <= 60           then '31-60'
    when current_date - a.next_due <= 90           then '61-90'
    when current_date - a.next_due <= 120          then '91-120'
    else '120+'
  end                                                                        as bucket,
  -- grade: ใช้ days_late ที่คำนวณแล้ว (pattern จาก 0024/0049)
  grade_for_days_late(
    case
      when c.pending_documents = true                then 0
      when c.status <> 'active' or a.next_due is null then 0
      else greatest(0, (current_date - a.next_due))
    end
  )                                                                          as grade,
  -- est_outstanding: จาก 0024 — ไม่เปลี่ยน
  coalesce(c.monthly_payment, 0) * coalesce(a.remaining_installments, 0)   as est_outstanding,
  -- overdue_amount: ใหม่ (0055) — suppress ตรงกับ logic days_late
  case
    when c.pending_documents = true                then 0::numeric
    when c.status <> 'active' or a.next_due is null then 0::numeric
    else coalesce(a.overdue_principal, 0::numeric)
  end                                                                        as overdue_amount
from contracts c
left join agg a         on a.contract_id = c.id
left join shops_basic s on s.id = c.shop_id;

-- CREATE OR REPLACE คง grant เดิมจาก 0049 อยู่แล้ว แต่ใส่ไว้เพื่อความปลอดภัย
-- (กรณีที่ Postgres reset grants ตอน replace — ป้องกัน Edge Function เจอ 42501)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply
-- ============================================================================

-- 1) columns ครบ 14 ตัว (13 เดิม + overdue_amount ท้ายสุด):
-- SELECT column_name, ordinal_position
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'v_contract_status'
--   ORDER BY ordinal_position;
-- expected ท้ายสุด: est_outstanding (pos 13), overdue_amount (pos 14)

-- 2) security_invoker ยังคงเปิด:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- expected: เห็น security_invoker=on ใน reloptions

-- 3) grants ครบ:
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_contract_status', 'SELECT');
-- expected: true ทั้งคู่

-- 4) smoke: ตรวจ S00017PNQ127 — ควรได้ overdue_amount=2565, penalty_due=700
-- SELECT contract_no, overdue_amount, penalty_due, days_late, bucket
--   FROM public.v_contract_status
--   WHERE contract_no = 'S00017PNQ127';
-- expected: overdue_amount=2565, penalty_due=700

-- 5) กรณี pending_documents=true ต้อง overdue_amount=0:
-- SELECT contract_id, overdue_amount, days_late
--   FROM public.v_contract_status
--   WHERE contract_id IN (
--     SELECT id FROM public.contracts WHERE pending_documents = true LIMIT 5
--   );
-- expected: overdue_amount=0, days_late=0 ทุกแถว
