-- 0093: เพิ่ม attributed_freelancer_id ใน v_device_return_report (รายงานพนักงานโทรตามเครื่องคืนได้กี่เคส/คน)
--
-- ที่มา: รายงานใหม่ "โทรตามเครื่องคืนได้กี่เคส/คน" ต้องรู้ว่าใครโทรจนลูกค้ายอมคืน
--   Pete เลือก attribution เดียวกับที่ commission ใช้อยู่ = device_returns.attributed_freelancer_id
--   (mig 0035 trigger auto-set จากคนบันทึก follow_up result='returned' ล่าสุดใน 30 วันก่อนคืนเครื่อง)
--   ไม่ใช้ assigned_to เพราะ Pete ต้องการ "คนที่โทรจนสำเร็จ" ไม่ใช่ "คนที่ถือเคส"
--
-- โครงเดิมทุกอย่างคงตาม 0074 (เวอร์ชันล่าสุดของ view นี้ — เช็คแล้วไม่มี migration
--   หลัง 0074 ที่ recreate view นี้อีก) — เพิ่มแค่คอลัมน์ attributed_freelancer_id
--   จาก device_returns ผ่าน latest_return CTE เดิม (ไม่เพิ่ม join ใหม่)
--
-- ⚠️ ห้ามแตะ principal_remaining / collectible_remaining เดิม (0074) — ใช้ที่อื่นอยู่
-- ชื่อฟรีแลนซ์ (full_name) ไม่ join ในนี้ — ฝั่ง frontend ดึงจาก getEmployees() แล้ว map เอง
--   (เลี่ยง join ซ้ำซ้อน + กัน view ใหญ่ขึ้นโดยไม่จำเป็น)

-- ============================================================================
-- v_device_return_report — เพิ่ม attributed_freelancer_id
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
  select distinct on (i.contract_id)
         i.contract_id,
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
  coalesce(ou.oldest_unpaid_amount, 0)
    + coalesce(ou.oldest_unpaid_penalty, 0)
    + coalesce(lr.repair_cost, lr.repair_fee, 0)   as collectible_remaining,
  lr.attributed_freelancer_id                       -- ใหม่ (0093): คนที่โทรจนลูกค้ายอมคืน, null = 18 เคสเก่า/ไม่มี follow_up ผูก
from public.contracts c
left join latest_return lr on lr.contract_id = c.id    -- LEFT JOIN (กัน 18 เคสเก่าหาย)
left join public.shops s   on s.id = c.shop_id
left join inst_agg ia      on ia.contract_id = c.id
left join oldest_unpaid ou on ou.contract_id = c.id    -- งวดค้างเก่าสุด (null = จ่ายครบทุกงวด)
where c.status in ('returned', 'returned_closed');

-- ============================================================================
-- GRANT — re-grant idempotent หลัง create or replace (ตาม pattern 0073/0074)
-- ============================================================================
grant select on public.v_device_return_report to authenticated, service_role;

-- ============================================================================
-- Verify checklist (รันผ่าน MCP หลัง apply — not executed here)
-- ============================================================================
-- a) grant ครบ:
--   select has_table_privilege('authenticated','public.v_device_return_report','SELECT'); -- true
--   select has_table_privilege('service_role','public.v_device_return_report','SELECT');  -- true
--
-- b) column ใหม่มีจริง + ไม่ทำแถวเดิมหาย (ยังต้อง = 87):
--   select count(*) from v_device_return_report;                                          -- expected 87
--   select count(*) from v_device_return_report where attributed_freelancer_id is not null; -- <= 87
--
-- c) sample เทียบตรงกับ device_returns.attributed_freelancer_id ตัวจริง:
--   select v.contract_no, v.attributed_freelancer_id, dr.attributed_freelancer_id
--   from v_device_return_report v
--   join device_returns dr on dr.contract_id = v.contract_id and dr.case_no = v.case_no
--   limit 10;
--
-- d) คอลัมน์เดิมยังอยู่ครบ ไม่ regress (เทียบ 0074):
--   select column_name from information_schema.columns
--   where table_name = 'v_device_return_report' order by ordinal_position;
