-- 0090: แก้ "ตารางสรุปสถานะลูกค้า" (v_contract_status) ให้เคสคืนเครื่องแล้วแต่ยังค้างเงิน
--       (status='returned') คำนวณ days_late/bucket/grade/overdue_amount จริง แทนที่จะถูกบังคับ
--       เป็น 0/normal/null เหมือนเคสที่ปิดจบแล้ว (closed/returned_closed/online)
--
-- ปัญหาเดิม (0055): เงื่อนไข `c.status <> 'active'` suppress ค่าทุก status ที่ไม่ใช่ active
--   ตั้งใจ suppress เฉพาะเคสที่ปิดจบแล้ว (closed/returned_closed/online) แต่ดันครอบ 'returned'
--   ไปด้วย → returned ที่ยังค้างงวดจริง 9-12 งวด กลับได้ bucket='normal' grade=null
--   → หลุดคิวพนักงานตามหนี้ทุกคน (คิว freelancer กรองด้วย .in('grade', ...) → null ไม่ match)
--
-- แก้โดย: เปลี่ยนเงื่อนไข suppress จาก `c.status <> 'active'`
--         เป็น `c.status not in ('active', 'returned')` ทุกจุด (days_late, bucket, grade,
--         overdue_amount) — 'returned' จะคำนวณค่าจริงเหมือน active, ส่วน closed/
--         returned_closed/online ยังถูก suppress เป็น 0/normal/null เหมือนเดิม
--
-- ผลกระทบที่ทราบแล้ว (Pete รับทราบ): เคส returned ที่ค้างเงินจะถูกนับเข้า bucket ล่าช้า
--   → ตัวเลข NPL/หนี้เสียใน /exec + monthly-report จะขยับขึ้น (ของจริงที่เคยถูกซ่อนอยู่)
--
-- หมายเหตุด้าน security: ใช้ CREATE OR REPLACE เพื่อคง grant + security_invoker=on
--   (freelancer RLS ต้องการ security_invoker=on — จาก 0018, คง grant จาก 0049/0055)

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
  -- days_late: suppress เป็น 0 เมื่อรอเอกสาร (pending_documents) หรือปิดจบแล้ว
  -- (0090: 'returned' ไม่ถูก suppress อีกต่อไป — ยังค้างเงิน ต้องคำนวณจริง)
  case
    when c.pending_documents = true                             then 0
    when c.status not in ('active','returned') or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end                                                                        as days_late,
  -- bucket: suppress เป็น 'normal' เมื่อรอเอกสาร หรือปิดจบแล้ว
  case
    when c.pending_documents = true                             then 'normal'
    when c.status not in ('active','returned') or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10                        then '1-10'
    when current_date - a.next_due <= 30                        then '11-30'
    when current_date - a.next_due <= 60                        then '31-60'
    when current_date - a.next_due <= 90                        then '61-90'
    when current_date - a.next_due <= 120                       then '91-120'
    else '120+'
  end                                                                        as bucket,
  -- grade: ใช้ days_late ที่คำนวณแล้ว (pattern จาก 0024/0049)
  grade_for_days_late(
    case
      when c.pending_documents = true                             then 0
      when c.status not in ('active','returned') or a.next_due is null then 0
      else greatest(0, (current_date - a.next_due))
    end
  )                                                                          as grade,
  -- est_outstanding: จาก 0024 — ไม่เปลี่ยน (ไม่ suppress ตาม status อยู่แล้ว)
  coalesce(c.monthly_payment, 0) * coalesce(a.remaining_installments, 0)   as est_outstanding,
  -- overdue_amount: จาก 0055 — suppress ตรงกับ logic days_late (0090: รวม returned)
  case
    when c.pending_documents = true                             then 0::numeric
    when c.status not in ('active','returned') or a.next_due is null then 0::numeric
    else coalesce(a.overdue_principal, 0::numeric)
  end                                                                        as overdue_amount
from contracts c
left join agg a         on a.contract_id = c.id
left join shops_basic s on s.id = c.shop_id;

-- CREATE OR REPLACE คง grant เดิมจาก 0049/0055 อยู่แล้ว แต่ใส่ไว้เพื่อความปลอดภัย
-- (กรณีที่ Postgres reset grants ตอน replace — ป้องกัน Edge Function เจอ 42501)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply
-- ============================================================================

-- 1) columns ยังครบ 14 ตัวเท่าเดิม (ไม่เพิ่ม/ลด column):
-- SELECT column_name, ordinal_position
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'v_contract_status'
--   ORDER BY ordinal_position;

-- 2) security_invoker ยังคงเปิด:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- expected: เห็น security_invoker=on ใน reloptions

-- 3) grants ครบ:
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_contract_status', 'SELECT');
-- expected: true ทั้งคู่

-- 4) returned ที่ยังค้างเงิน ต้องมี bucket จริง ไม่ใช่ 'normal' เสมอไป:
-- SELECT status, bucket, grade, count(*), sum(overdue_amount)
--   FROM public.v_contract_status
--   WHERE status = 'returned'
--   GROUP BY status, bucket, grade
--   ORDER BY bucket;
-- expected: เห็นหลาย bucket (1-10 / 11-30 / ... ) ไม่ใช่ทุกแถวกอง 'normal'

-- 5) closed/returned_closed/online ต้องยังถูก suppress เหมือนเดิม (ไม่เปลี่ยนพฤติกรรม):
-- SELECT status, bucket, grade, overdue_amount, days_late
--   FROM public.v_contract_status
--   WHERE status IN ('closed','returned_closed','online')
--   LIMIT 20;
-- expected: bucket='normal', grade IS NULL, overdue_amount=0, days_late=0 ทุกแถว

-- 6) smoke: pending_documents=true ต้องยังคง suppress (ไม่เปลี่ยนพฤติกรรม):
-- SELECT contract_id, status, overdue_amount, days_late
--   FROM public.v_contract_status
--   WHERE contract_id IN (
--     SELECT id FROM public.contracts WHERE pending_documents = true LIMIT 5
--   );
-- expected: overdue_amount=0, days_late=0 ทุกแถว
