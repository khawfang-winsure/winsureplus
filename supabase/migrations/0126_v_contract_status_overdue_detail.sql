-- 0126: เพิ่มรายละเอียดงวดให้ v_contract_status (รองรับหน้า "ลูกค้าล่าช้า-หนี้เสีย" /overdue)
--
-- ปัญหาเดิม: หน้า /overdue อยากโชว์ "จ่ายไปแล้วกี่งวด/กี่บาท" + "เลยกำหนดกี่งวด"
--            แต่ v_contract_status (ล่าสุดจาก 0090) มีแค่ remaining_installments/overdue_amount
--            รวม ไม่แยกว่าจ่ายครบไปแล้วกี่งวด/กี่บาท และไม่มีตัวนับ "จำนวนงวดที่เลยกำหนด"
--
-- แก้โดย: ต่อท้าย 3 คอลัมน์ใหม่ในเดียวกับ CTE agg เดิม (create or replace view — คงคอลัมน์เดิม
--         ทั้ง 14 ตัว ลำดับเดิมเป๊ะ จาก 0090 ไม่แตะ):
--   paid_installments  = จำนวนงวดที่จ่ายครบแล้ว (paid_at is not null — ระบบตั้ง paid_at เฉพาะตอน
--                         จ่ายครบเต็มจำนวนเท่านั้น ดู 0115 record_payment_spread: paid_at = fully
--                         ? p_paid_at : null) — ไม่ suppress ตาม status เพราะเป็นประวัติจ่ายจริง
--   paid_amount_total  = sum(paid_amount) รวมทุกงวด (รวมงวดจ่ายบางส่วนด้วย) — paid_amount เป็น
--                         เงินต้นล้วน ไม่รวมค่าปรับ (ค่าปรับอยู่คนละคอลัมน์ penalty_amount/
--                         penalty_paid_amount) — ไม่ suppress เช่นกัน
--   late_installments  = จำนวนงวดที่ due_date < current_date และยังไม่จ่ายครบ (paid_at is null)
--                         suppress ตาม logic เดียวกับ days_late/overdue_amount (0 เมื่อ
--                         pending_documents=true หรือ status not in ('active','returned'))
--
-- หมายเหตุด้าน security: ใช้ CREATE OR REPLACE เพื่อคง grant + security_invoker=on
--   (freelancer RLS ต้องการ security_invoker=on — จาก 0018, คง grant จาก 0049/0055/0090)

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
    )                                                                        as overdue_principal,
    -- 0126: งวดที่จ่ายครบแล้ว (paid_at is not null = จ่ายครบเต็มจำนวน)
    count(*) filter (where i.paid_at is not null)                           as paid_installments_count,
    -- 0126: ยอดเงินต้นที่จ่ายแล้วรวม (รวมงวดจ่ายบางส่วน ไม่รวมค่าปรับ)
    coalesce(sum(i.paid_amount), 0::numeric)                                as paid_amount_sum,
    -- 0126: งวดที่เลยกำหนดและยังไม่จ่ายครบ (ไม่นับปรับ suppress ที่ชั้น select เหมือน overdue_amount)
    count(*) filter (where i.paid_at is null and i.due_date < current_date) as late_installments_count
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
  end                                                                        as overdue_amount,
  -- 0126: paid_installments — ประวัติจ่ายจริง ไม่ suppress ตาม status
  coalesce(a.paid_installments_count, 0)                                     as paid_installments,
  -- 0126: paid_amount_total — ประวัติจ่ายจริง ไม่ suppress ตาม status
  coalesce(a.paid_amount_sum, 0::numeric)                                    as paid_amount_total,
  -- 0126: late_installments — suppress ตรงกับ logic เดียวกับ days_late/overdue_amount
  case
    when c.pending_documents = true                             then 0
    when c.status not in ('active','returned') or a.next_due is null then 0
    else coalesce(a.late_installments_count, 0)
  end                                                                        as late_installments
from contracts c
left join agg a         on a.contract_id = c.id
left join shops_basic s on s.id = c.shop_id;

-- CREATE OR REPLACE คง grant เดิมจาก 0049/0055/0090 อยู่แล้ว แต่ใส่ไว้เพื่อความปลอดภัย
-- (กรณีที่ Postgres reset grants ตอน replace — ป้องกัน Edge Function เจอ 42501)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply
-- ============================================================================

-- 1) columns ครบ 17 ตัว (14 เดิม + 3 ใหม่ต่อท้าย):
-- SELECT column_name, ordinal_position
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'v_contract_status'
--   ORDER BY ordinal_position;
-- expected ท้ายสุด: overdue_amount (pos 14), paid_installments (15),
--   paid_amount_total (16), late_installments (17)

-- 2) security_invoker ยังคงเปิด:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- expected: เห็น security_invoker=on ใน reloptions

-- 3) grants ครบ:
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_contract_status', 'SELECT');
-- expected: true ทั้งคู่

-- 4) smoke: paid_installments + remaining_installments ต้องรวมกัน <= จำนวนงวดทั้งหมดของสัญญา
-- SELECT contract_no, remaining_installments, paid_installments, late_installments,
--        paid_amount_total, overdue_amount
--   FROM public.v_contract_status
--   WHERE status = 'active'
--   ORDER BY late_installments DESC
--   LIMIT 20;

-- 5) closed/returned_closed/online ต้องยัง suppress late_installments=0 (paid_installments/
--    paid_amount_total ไม่ suppress — เป็นประวัติจ่ายจริง คาดว่ามีค่า):
-- SELECT status, late_installments, paid_installments, paid_amount_total
--   FROM public.v_contract_status
--   WHERE status IN ('closed','returned_closed','online')
--   LIMIT 20;
-- expected: late_installments=0 ทุกแถว, paid_installments/paid_amount_total อาจ > 0 ได้
