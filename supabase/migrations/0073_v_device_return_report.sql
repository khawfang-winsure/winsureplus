-- 0073: รายงานภาพรวมการคืนเครื่อง (admin) — view v_device_return_report + v_shop_contract_totals
--
-- ที่มา: หน้ารายงาน "การคืนเครื่อง" ต้องการสรุป 9 หัวข้อ (KPI / รายเดือน / รายร้าน /
--   เคยจ่ายก่อนคืน / อัตราคืนเครื่องต่อร้าน / pipeline สถานะเครื่องในมือ ฯลฯ)
--   pure fn buildReturnReport() ใน src/lib/returnReport.ts จะ aggregate จาก 2 view นี้
--
-- ⚠️ LEFT JOIN device_returns (ห้าม inner join):
--   มีเคส returned_closed เก่า 18 เคสที่ "ไม่มีแถวใน device_returns" (แก้สถานะย้อนหลัง)
--   ถ้า inner join เคสกลุ่มนี้จะหาย → closeRate / total ผิด
--   ปัจจุบัน: returned=69 (มี device_returns ครบ), returned_closed=18 (ไม่มี device_returns)
--
-- device_returns 1 สัญญาอาจมีหลายแถว (case_no 1/2/3) → เลือก "แถวล่าสุดต่อสัญญา"
--   ด้วย distinct on (contract_id) order by created_at desc
--
-- pattern grant: ตาม 0057/0066 — view ธรรมดา + grant select to authenticated, service_role
--   (admin gate ทำที่ frontend/route)

-- ============================================================================
-- 1) v_device_return_report — 1 แถวต่อ 1 สัญญาที่ status IN ('returned','returned_closed')
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
         dr.sale_price
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
  coalesce(c.device_price, 0)            as device_price
from public.contracts c
left join latest_return lr on lr.contract_id = c.id    -- LEFT JOIN (กัน 18 เคสเก่าหาย)
left join public.shops s   on s.id = c.shop_id
left join inst_agg ia      on ia.contract_id = c.id
where c.status in ('returned', 'returned_closed');

-- ============================================================================
-- 2) v_shop_contract_totals — นับสัญญาทั้งหมดต่อร้าน (ทุก status)
--    ใช้เป็นตัวหารของ "อัตราคืนเครื่องต่อร้าน" (group by ฝั่ง DB กันชน PostgREST cap)
-- ============================================================================
create or replace view public.v_shop_contract_totals as
select c.shop_id,
       count(*) as total_contracts
from public.contracts c
where c.shop_id is not null
group by c.shop_id;

-- ============================================================================
-- GRANT — view ต้อง grant ตรง (0017 default privileges ไม่ครอบ views)
-- re-grant idempotent หลัง create or replace (ตาม pattern 0057/0066)
-- ============================================================================
grant select on public.v_device_return_report to authenticated, service_role;
grant select on public.v_shop_contract_totals to authenticated, service_role;

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (ผ่าน MCP — not executed here)
-- ============================================================================
-- a) grants ครบ:
--   select has_table_privilege('authenticated','public.v_device_return_report','SELECT'); -- true
--   select has_table_privilege('service_role','public.v_shop_contract_totals','SELECT');  -- true
--
-- b) นับแถว = ต้อง = 87 (returned 69 + returned_closed 18) ครบ ไม่หาย:
--   select count(*) from v_device_return_report;                          -- expected 87
--   select status, count(*) from v_device_return_report group by status;  -- returned 69 / returned_closed 18
--
-- c) 18 เคสเก่าต้องมี return_date = null (ไม่มีแถว device_returns):
--   select count(*) from v_device_return_report where return_date is null; -- expected 18
--
-- d) เงินต้นค้างเป็นค่าจริง (>=0):
--   select contract_no, principal_remaining, repair_cost, resale, device_price
--   from v_device_return_report order by principal_remaining desc limit 5;
--
-- e) ตัวหารอัตราคืน:
--   select count(*) as shops_with_contracts, sum(total_contracts) as all_contracts
--   from v_shop_contract_totals;
