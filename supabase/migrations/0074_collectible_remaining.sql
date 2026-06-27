-- 0074: เพิ่ม collectible_remaining ใน v_device_return_report
--
-- ที่มา: รายงานคืนเครื่องเดิมมีแต่ principal_remaining = Σ ทุกงวด (มูลค่าหนี้คงเหลือทั้งก้อน
--   = "ความเสี่ยง"). แต่ "ยอดที่ตามเก็บได้จริงตอนนี้" ตามกฎคืนเครื่อง = 1 งวดเก่าสุดที่ค้าง
--   + ค่าปรับของงวดนั้น + ค่าซ่อม เท่านั้น. 2 ตัวเลขนี้คนละความหมาย ต้องแยกให้ชัด
--
-- collectible_remaining = (งวดค้างเก่าสุด: amount − paid_amount, ไม่ติดลบ)
--                       + (ค่าปรับของงวดเก่าสุดนั้น)
--                       + (ค่าซ่อม repair_cost ?? repair_fee ?? 0)
--   = "ยอดตามเก็บ" ตามกฎคืนเครื่อง (แยกจาก principal_remaining = Σทุกงวด = ความเสี่ยง)
--
-- ⚠️ ห้ามแตะ principal_remaining เดิม — ยังใช้คำนวณ netDamage ในรายงาน
-- โครงเดิมทุกอย่างคงตาม 0073 — เพิ่มแค่ CTE oldest_unpaid + คอลัมน์ใหม่ 1 คอลัมน์

-- ============================================================================
-- v_device_return_report — เพิ่ม collectible_remaining
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
    + coalesce(lr.repair_cost, lr.repair_fee, 0)   as collectible_remaining
from public.contracts c
left join latest_return lr on lr.contract_id = c.id    -- LEFT JOIN (กัน 18 เคสเก่าหาย)
left join public.shops s   on s.id = c.shop_id
left join inst_agg ia      on ia.contract_id = c.id
left join oldest_unpaid ou on ou.contract_id = c.id    -- งวดค้างเก่าสุด (null = จ่ายครบทุกงวด)
where c.status in ('returned', 'returned_closed');

-- ============================================================================
-- GRANT — re-grant idempotent หลัง create or replace (ตาม pattern 0073)
-- ============================================================================
grant select on public.v_device_return_report to authenticated, service_role;

-- ============================================================================
-- Verify checklist (รันผ่าน MCP หลัง apply — not executed here)
-- ============================================================================
-- a) grant ครบ:
--   select has_table_privilege('authenticated','public.v_device_return_report','SELECT'); -- true
--
-- b) collectible_remaining <= principal_remaining (1 งวด+ปรับ+ซ่อม ไม่ควรเกิน Σทุกงวด+ซ่อม
--    เว้นเคสปรับ > งวดอื่น — แค่ sanity เช็คว่าไม่ติดลบ ไม่ null):
--   select contract_no, principal_remaining, collectible_remaining, repair_cost
--   from v_device_return_report order by collectible_remaining desc limit 10;
--
-- c) เคสจ่ายครบทุกงวด (returned_closed) ที่ไม่มีงวดค้าง → collectible = ค่าซ่อมเท่านั้น:
--   select count(*) from v_device_return_report
--   where collectible_remaining = coalesce(repair_cost, 0); -- เคสไม่มีงวดค้าง
