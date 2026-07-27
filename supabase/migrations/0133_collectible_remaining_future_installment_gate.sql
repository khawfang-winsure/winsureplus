-- 0133: กันเคสคืนเครื่องที่จ่ายงวดล่วงหน้า ไม่ให้ยอดตามเก็บนับงวดที่ยังไม่ครบกำหนด
--
-- บั๊กเดิม: collectible_remaining (0074/0093/0130) หยิบ "งวดค้างเก่าสุด" มาคิดยอดตามเก็บเสมอ
--   ไม่ว่า due_date จะอยู่ก่อนหรือหลังวันที่ลูกค้าคืนเครื่อง — เคสที่ลูกค้าจ่ายงวดปัจจุบันไปแล้วก่อนคืนเครื่อง
--   (เช่น S00025PNQ34 อานนท์: คืน 7/7 จ่ายงวด1 ครบ 25/7 แล้ว) กลับโชว์ยอดงวดถัดไป (งวด2 ครบ 25/8) ทั้งที่
--   ยังไม่ถึงกำหนด ควรเป็น 0
--
-- กติกาที่ถูก (Pete เคาะ เหมือน 0130 เดิม แต่เพิ่ม gate):
--   ยอดตามเก็บนับงวดเก่าสุดที่ยังไม่จ่าย เฉพาะเมื่อ due_date <= วันคืนเครื่อง
--   ถ้า due_date > วันคืน → งวด+ค่าปรับของงวดนั้น = 0 (ค่าซ่อมยังบวกตามเดิม ไม่เปลี่ยน)
--   ไม่เปลี่ยนกฎ "1 งวด cap" เดิม — ยังคงหยิบงวดค้างเก่าสุดตัวเดียว แค่ zero-out เมื่อยังไม่ถึงกำหนด
--
-- ⚠️ กับดักวันคืนไม่น่าเชื่อถือ (เหมือน pattern ใน db.ts buildFreelancerQueueRows):
--   device_returns.created_at ก่อน 2026-07-02 = วันที่ import ข้อมูล ไม่ใช่วันคืนจริง
--   → gate เฉพาะเมื่อ (created_at at time zone 'Asia/Bangkok')::date >= '2026-07-02'
--     ถ้าวันคืนไม่น่าเชื่อถือ หรือไม่มีแถว device_returns เลย → ไม่ apply filter (คงพฤติกรรมเดิม 0074/0130 เป๊ะ)
--   ค่าคงที่ RETURN_DATE_RELIABLE_FROM='2026-07-02' นี้ mirror ตัวแปรชื่อเดียวกันใน src/lib/db.ts —
--   ถ้าจะเปลี่ยนวันนี้ในอนาคต ต้องแก้ทั้ง 2 ที่ให้ตรงกัน
--
-- แก้ 2 views (create or replace, additive เป๊ะ — ไม่ drop อะไร):
--   1) v_device_return_report (mirror 0093 ล่าสุด — เวอร์ชันปัจจุบันไม่มี security_invoker=on จึงไม่ใส่เพิ่ม
--      กัน behavior เปลี่ยนโดยไม่ตั้งใจ)
--   2) v_contract_status (mirror 0130 ล่าสุด — คง security_invoker=on ตามเดิม)
--
-- ⚠️ ห้ามแตะ logic อื่นในทั้ง 2 views (bucket/days_late/grade/est_outstanding/overdue_amount/principal_remaining ฯลฯ)
--   แก้เฉพาะสูตร collectible_remaining เท่านั้น

-- ============================================================================
-- 1) v_device_return_report — เพิ่ม future-installment gate ใน collectible_remaining
-- ============================================================================
create or replace view public.v_device_return_report as
with latest_return as (
  -- แถว device_returns ล่าสุดต่อสัญญา (case_no 1/2/3 → เอาอันใหม่สุด)
  select distinct on (dr.contract_id)
         dr.contract_id,
         dr.created_at   as return_date,
         dr.case_no,
         dr.device_status,
         dr.return_method,
         dr.repair_cost,
         dr.repair_fee,
         dr.sale_price,
         dr.attributed_freelancer_id
  from public.device_returns dr
  order by dr.contract_id, dr.created_at desc
),
inst_agg as (
  -- งวดของแต่ละสัญญา: นับงวด, งวดที่จ่าย (paid_at not null), เงินต้นค้าง
  select i.contract_id,
         count(*)                                  as total_installments,
         count(*) filter (where i.paid_at is not null) as paid_installments,
         coalesce(sum(greatest(i.amount - coalesce(i.paid_amount,0), 0)), 0) as principal_remaining
  from public.installments i
  group by i.contract_id
),
oldest_unpaid as (
  -- งวดค้างเก่าสุดต่อสัญญา (1 งวด) — ใช้เป็นฐาน "ยอดตามเก็บ" ตามกฎคืนเครื่อง
  -- 0133: เพิ่ม due_date เพื่อเทียบกับวันคืนเครื่อง (gate งวดที่ยังไม่ครบกำหนด)
  select distinct on (i.contract_id)
         i.contract_id,
         i.due_date                                          as oldest_unpaid_due_date,
         greatest(i.amount - coalesce(i.paid_amount, 0), 0) as oldest_unpaid_amount,
         coalesce(i.penalty_amount, 0)                       as oldest_unpaid_penalty
  from public.installments i
  where i.paid_at is null
  order by i.contract_id, i.due_date asc
)
select
  c.id                                   as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name                                 as shop_name,
  c.current_grade                        as grade,
  c.status,
  lr.return_date,                                       -- null ได้ (18 เคสเก่า)
  lr.case_no,
  lr.device_status,
  lr.return_method,
  coalesce(ia.total_installments, 0)     as total_installments,
  coalesce(ia.paid_installments, 0)      as paid_installments,
  (coalesce(ia.paid_installments, 0) > 0) as ever_paid,
  coalesce(ia.principal_remaining, 0)    as principal_remaining,
  coalesce(lr.repair_cost, lr.repair_fee, 0) as repair_cost,
  coalesce(lr.sale_price, 0)             as resale,
  coalesce(c.device_price, 0)            as device_price,
  -- 0133: gate — ถ้าวันคืนน่าเชื่อถือ (>= 2026-07-02) และงวดเก่าสุดครบกำหนด "หลัง" วันคืน → งวด+ค่าปรับ = 0
  --   (ค่าซ่อมยังบวกเสมอ ไม่ผูกกับ gate นี้)
  case
    when lr.return_date is not null
      and (lr.return_date at time zone 'Asia/Bangkok')::date >= '2026-07-02'::date
      and ou.oldest_unpaid_due_date is not null
      and ou.oldest_unpaid_due_date > (lr.return_date at time zone 'Asia/Bangkok')::date
    then 0
    else coalesce(ou.oldest_unpaid_amount, 0) + coalesce(ou.oldest_unpaid_penalty, 0)
  end
    + coalesce(lr.repair_cost, lr.repair_fee, 0)   as collectible_remaining,
  lr.attributed_freelancer_id                       -- คนที่โทรจนลูกค้ายอมคืน, null = 18 เคสเก่า/ไม่มี follow_up ผูก
from public.contracts c
left join latest_return lr on lr.contract_id = c.id    -- LEFT JOIN (กัน 18 เคสเก่าหาย)
left join public.shops s   on s.id = c.shop_id
left join inst_agg ia      on ia.contract_id = c.id
left join oldest_unpaid ou on ou.contract_id = c.id    -- งวดค้างเก่าสุด (null = จ่ายครบทุกงวด)
where c.status in ('returned', 'returned_closed');

grant select on public.v_device_return_report to authenticated, service_role;

-- ============================================================================
-- 2) v_contract_status — เพิ่ม future-installment gate ใน collectible_remaining เดียวกัน
-- ============================================================================
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
-- งวดค้างเก่าสุดต่อสัญญา (1 งวด) — mirror v_device_return_report เป๊ะ เพื่อให้ collectible_remaining ตรงกัน
-- 0133: เพิ่ม due_date เพื่อเทียบกับวันคืนเครื่อง
oldest_unpaid as (
  select distinct on (i.contract_id)
         i.contract_id,
         i.due_date                                          as oldest_unpaid_due_date,
         greatest(i.amount - coalesce(i.paid_amount, 0), 0) as oldest_unpaid_amount,
         coalesce(i.penalty_amount, 0)                       as oldest_unpaid_penalty
  from installments i
  where i.paid_at is null
  order by i.contract_id, i.due_date asc
),
-- แถว device_returns ล่าสุดต่อสัญญา (case_no 1/2/3 → เอาอันใหม่สุด) — mirror v_device_return_report
latest_return as (
  select distinct on (dr.contract_id)
         dr.contract_id,
         dr.created_at as return_date,
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
  -- ยอดตามเก็บจริงของเคสคืนเครื่อง (null สำหรับสถานะอื่น) — mirror v_device_return_report เป๊ะ
  -- 0133: gate — ถ้าวันคืนน่าเชื่อถือ (>= 2026-07-02) และงวดเก่าสุดครบกำหนด "หลัง" วันคืน → งวด+ค่าปรับ = 0
  case
    when c.status in ('returned', 'returned_closed') then
      case
        when lr.return_date is not null
          and (lr.return_date at time zone 'Asia/Bangkok')::date >= '2026-07-02'::date
          and ou.oldest_unpaid_due_date is not null
          and ou.oldest_unpaid_due_date > (lr.return_date at time zone 'Asia/Bangkok')::date
        then 0
        else coalesce(ou.oldest_unpaid_amount, 0) + coalesce(ou.oldest_unpaid_penalty, 0)
      end
        + coalesce(lr.repair_cost, lr.repair_fee, 0)
    else null
  end                                                                        as collectible_remaining
from contracts c
left join agg a           on a.contract_id = c.id
left join shops_basic s   on s.id = c.shop_id
left join oldest_unpaid ou on ou.contract_id = c.id
left join latest_return lr on lr.contract_id = c.id;

-- CREATE OR REPLACE คง grant เดิมจาก 0049/0055/0090/0126/0128/0130 อยู่แล้ว แต่ใส่ไว้เพื่อความปลอดภัย
-- (กรณีที่ Postgres reset grants ตอน replace — ป้องกัน Edge Function เจอ 42501)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply
-- ============================================================================

-- 1) grants ครบทั้ง 2 views:
-- SELECT has_table_privilege('authenticated', 'public.v_device_return_report', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_device_return_report', 'SELECT');
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_contract_status', 'SELECT');
-- expected: true ทั้งหมด

-- 2) v_contract_status security_invoker ยังคงเปิด:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- expected: เห็น security_invoker=on ใน reloptions

-- 3) เคสจริง S00025PNQ34 (อานนท์) — คืน 7/7 จ่ายงวด1 (ครบ 25/7) แล้ว → คาดหวัง 0 (เดิมโชว์ 3,955):
-- SELECT contract_no, status, collectible_remaining FROM public.v_contract_status WHERE contract_no = 'S00025PNQ34';
-- SELECT contract_no, status, collectible_remaining FROM public.v_device_return_report WHERE contract_no = 'S00025PNQ34';

-- 4) เคสค้างจริง (due_date <= วันคืน) ต้องไม่เปลี่ยนพฤติกรรม — สุ่มเช็คเคสเดิมจาก 0130 smoke
--    (S00015PNQ050=3122, S00015PNQ128=2712) ยอดต้องเท่าเดิม:
-- SELECT contract_no, status, collectible_remaining
--   FROM public.v_contract_status
--   WHERE contract_no IN ('S00015PNQ050', 'S00015PNQ128');

-- 5) เทียบ 2 views ต้องตรงกันทุกเคส returned/returned_closed (เหมือน 0130 checklist เดิม):
-- SELECT vcs.contract_no, vcs.collectible_remaining AS vcs_val, vdr.collectible_remaining AS vdr_val
--   FROM public.v_contract_status vcs
--   JOIN public.v_device_return_report vdr ON vdr.contract_id = vcs.contract_id
--   WHERE vcs.collectible_remaining IS DISTINCT FROM vdr.collectible_remaining;
-- expected: 0 rows

-- 6) เคสวันคืนไม่น่าเชื่อถือ (< 2026-07-02 หรือไม่มีแถว device_returns) ต้องไม่ apply gate
--    — เทียบยอดก่อน/หลัง apply migration นี้กับเคสกลุ่มนี้ต้องเท่ากันเป๊ะ:
-- SELECT count(*) FROM public.v_device_return_report vdr
--   JOIN public.device_returns dr ON dr.contract_id = vdr.contract_id
--   WHERE (dr.created_at AT TIME ZONE 'Asia/Bangkok')::date < '2026-07-02'::date;
