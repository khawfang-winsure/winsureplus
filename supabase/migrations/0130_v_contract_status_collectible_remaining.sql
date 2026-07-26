-- 0130: เพิ่ม collectible_remaining ให้ v_contract_status (รองรับหน้า /overdue โชว์ "ยอดตามเก็บจริง" ของเคสคืนเครื่อง)
--
-- ปัญหาเดิม: หน้า /overdue โชว์ยอด "งวดที่เหลือทั้งหมด" (est_outstanding/overdue_amount) สำหรับเคสคืนเครื่อง
--   (status='returned'/'returned_closed') ซึ่งใหญ่เกินจริง — พนักงานเข้าใจผิดว่าต้องตามเก็บงวดที่เหลือทั้งก้อน
--   ทั้งที่กฎคืนเครื่อง (Pete เคาะแล้ว, ดู 0074) = ตามเก็บแค่ "1 งวดค้างเก่าสุด + ค่าปรับของงวดนั้น + ค่าซ่อม"
--
-- แก้โดย: เพิ่มคอลัมน์ collectible_remaining ต่อท้าย (ตัวที่ 22 — คงคอลัมน์เดิมทั้ง 21 ตัวจาก 0128 ลำดับเดิมเป๊ะ)
--   นิยาม mirror v_device_return_report.collectible_remaining (0074) เป๊ะ เพื่อให้ /overdue กับรายงานคืนเครื่อง
--   ไม่ขัดกัน:
--     collectible_remaining = (งวดค้างเก่าสุด: amount − paid_amount, ไม่ติดลบ, distinct on ... order by due_date
--       asc where paid_at is null)
--                            + (ค่าปรับของงวดเก่าสุดนั้นตัวเดียว — ไม่ใช่ sum ค่าปรับทุกงวดค้าง แม้ agg CTE เดิม
--                              ของ view นี้จะมี penalty_due แบบ sum อยู่แล้วก็ตาม — เจตนาแยกกันชัดๆ เพราะ
--                              ต้องการ "ค่าปรับของงวดที่กำลังตามเก็บ" ไม่ใช่ค่าปรับสะสมทุกงวด ถึงในทางปฏิบัติ
--                              ปกติจะมีงวดเดียวที่ penalty_amount>0 พร้อมกัน ก็ตาม (ดู 0116 sanity 5i) — mirror
--                              สูตร 0074 ตรงๆ ปลอดภัยกว่าอนุมานว่าค่าเท่ากันเสมอ)
--                            + (ค่าซ่อม: coalesce(repair_cost, repair_fee, 0) จาก device_returns แถวล่าสุดของ
--                              สัญญานั้น — canonical field ที่ UI เขียนจริงคือ repair_fee ผ่าน Returns.tsx)
--   status อื่นนอกจาก returned/returned_closed → null (ไม่เกี่ยวกับกฎนี้ — Overdue.tsx จะใช้เฉพาะ returned)
--
-- ⚠️ ห้ามแตะ logic bucket/days_late/grade/est_outstanding/overdue_amount เดิม (ใช้ queue routing/compliance/
--   letters — Pete เคาะแล้วว่า returned ยังต้องมี bucket จริงเพื่อ routing)
--
-- หมายเหตุด้าน security: ใช้ CREATE OR REPLACE เพื่อคง grant + security_invoker=on (freelancer RLS ต้องการ
--   security_invoker=on — จาก 0018, คง grant จาก 0049/0055/0090/0126/0128) — /overdue guard ที่ App.tsx จำกัด
--   admin/staff เท่านั้นอยู่แล้ว (isAdminOrStaff) จึงไม่ต้องกังวล RLS ของ device_returns บัง freelancer (freelancer
--   เข้าหน้านี้ไม่ได้อยู่แล้ว)

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
),
-- 0130: งวดค้างเก่าสุดต่อสัญญา (1 งวด) — mirror 0074 oldest_unpaid เป๊ะ เพื่อให้ collectible_remaining
--   ตรงกับ v_device_return_report
oldest_unpaid as (
  select distinct on (i.contract_id)
         i.contract_id,
         greatest(i.amount - coalesce(i.paid_amount, 0), 0) as oldest_unpaid_amount,
         coalesce(i.penalty_amount, 0)                       as oldest_unpaid_penalty
  from installments i
  where i.paid_at is null
  order by i.contract_id, i.due_date asc
),
-- 0130: แถว device_returns ล่าสุดต่อสัญญา (case_no 1/2/3 → เอาอันใหม่สุด) — mirror 0074 latest_return
latest_return as (
  select distinct on (dr.contract_id)
         dr.contract_id,
         dr.repair_cost,
         dr.repair_fee
  from device_returns dr
  order by dr.contract_id, dr.created_at desc
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
  end                                                                        as late_installments,
  -- 0128: เลขที่ INV / รุ่นเครื่อง / ความจุ / จำนวนเดือนในสัญญา — สำหรับ CSV export /overdue
  c.inv_no                                                                   as inv_no,
  c.model                                                                    as model,
  c.storage                                                                  as storage,
  c.term_months                                                              as term_months,
  -- 0130: ยอดตามเก็บจริงของเคสคืนเครื่อง (null สำหรับสถานะอื่น) — mirror v_device_return_report เป๊ะ
  case
    when c.status in ('returned', 'returned_closed') then
      coalesce(ou.oldest_unpaid_amount, 0)
        + coalesce(ou.oldest_unpaid_penalty, 0)
        + coalesce(lr.repair_cost, lr.repair_fee, 0)
    else null
  end                                                                        as collectible_remaining
from contracts c
left join agg a           on a.contract_id = c.id
left join shops_basic s   on s.id = c.shop_id
left join oldest_unpaid ou on ou.contract_id = c.id
left join latest_return lr on lr.contract_id = c.id;

-- CREATE OR REPLACE คง grant เดิมจาก 0049/0055/0090/0126/0128 อยู่แล้ว แต่ใส่ไว้เพื่อความปลอดภัย
-- (กรณีที่ Postgres reset grants ตอน replace — ป้องกัน Edge Function เจอ 42501)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply
-- ============================================================================

-- 1) columns ครบ 22 ตัว (21 เดิม + 1 ใหม่ต่อท้าย):
-- SELECT column_name, ordinal_position
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'v_contract_status'
--   ORDER BY ordinal_position;
-- expected ท้ายสุด: term_months (pos 21), collectible_remaining (22)

-- 2) security_invoker ยังคงเปิด:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- expected: เห็น security_invoker=on ใน reloptions

-- 3) grants ครบ:
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_contract_status', 'SELECT');
-- expected: true ทั้งคู่

-- 4) smoke เคสตัวอย่าง Pete ยืนยัน (S00015PNQ050=3122, S00015PNQ128=2712):
-- SELECT contract_no, status, collectible_remaining
--   FROM public.v_contract_status
--   WHERE contract_no IN ('S00015PNQ050', 'S00015PNQ128');

-- 5) เทียบกับ v_device_return_report — ต้องตรงกันทุกเคส returned/returned_closed:
-- SELECT vcs.contract_no, vcs.collectible_remaining AS vcs_val, vdr.collectible_remaining AS vdr_val
--   FROM public.v_contract_status vcs
--   JOIN public.v_device_return_report vdr ON vdr.contract_id = vcs.contract_id
--   WHERE vcs.collectible_remaining IS DISTINCT FROM vdr.collectible_remaining;
-- expected: 0 rows

-- 6) status อื่นต้องเป็น null:
-- SELECT count(*) FROM public.v_contract_status
--   WHERE status NOT IN ('returned','returned_closed') AND collectible_remaining IS NOT NULL;
-- expected: 0
