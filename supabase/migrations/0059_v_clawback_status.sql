-- 0059: สร้าง view v_clawback_status รวม aggregate งวดล่าช้า/ยังไม่จ่าย ต่อสัญญา (แก้ PAGE_CAP ค่าคอม clawback)

-- ============================================================================
-- v_clawback_status
-- 1 แถว ต่อ 1 สัญญา — รวม 4 ค่าที่ commission.ts ต้องการ:
--   earliest_paid_late_due  = MIN(due_date) ในบรรดางวดที่จ่ายแล้วและจ่ายช้า (paid_at::date >= due_date + 30d)
--   earliest_paid_late_no   = installment_no ของงวดนั้น
--   oldest_unpaid_due       = MIN(due_date) ของงวดที่ยังไม่จ่าย
--   oldest_unpaid_no        = installment_no ของงวดนั้น
--
-- ใช้ DISTINCT ON แทน MIN แยก เพื่อให้ _due กับ _no มาจากแถวเดียวกันเสมอ
-- ไม่ติด PAGE_CAP — aggregate ใน DB คืนสูงสุด ~2,400 แถว (1 ต่อสัญญา)
-- ============================================================================

create or replace view public.v_clawback_status as
with earliest_paid_late as (
  -- หางวดที่จ่ายช้าที่สุด (due เร็วสุด) ใช้ DISTINCT ON sort due_date ASC
  select distinct on (contract_id)
    contract_id,
    due_date   as earliest_paid_late_due,
    installment_no as earliest_paid_late_no
  from public.installments
  where
    paid_at is not null
    and paid_at::date >= (due_date + interval '30 days')::date
  order by contract_id, due_date asc
),
oldest_unpaid as (
  -- หางวดที่ยังไม่จ่ายที่ครบกำหนดเร็วสุด
  select distinct on (contract_id)
    contract_id,
    due_date   as oldest_unpaid_due,
    installment_no as oldest_unpaid_no
  from public.installments
  where paid_at is null
  order by contract_id, due_date asc
)
select
  c.id                              as contract_id,
  epl.earliest_paid_late_due,
  epl.earliest_paid_late_no,
  ou.oldest_unpaid_due,
  ou.oldest_unpaid_no
from public.contracts c
left join earliest_paid_late epl on epl.contract_id = c.id
left join oldest_unpaid       ou  on ou.contract_id  = c.id;

-- ============================================================================
-- GRANT — views ต้อง grant ตรง (0017 default privileges ไม่ครอบ views)
-- ============================================================================

grant select on public.v_clawback_status to authenticated, service_role;

-- ============================================================================
-- verify หลัง apply:
-- select has_table_privilege('service_role', 'public.v_clawback_status', 'SELECT');
-- select count(*) from v_clawback_status;                                            -- ≈ จำนวนสัญญาทั้งหมด
-- select count(*) from v_clawback_status where earliest_paid_late_due is not null;  -- งวดจ่ายช้า
-- select count(*) from v_clawback_status where oldest_unpaid_due is not null;       -- ยังมีงวดค้าง
-- เทียบ ground truth (ไม่ cap):
-- select count(distinct contract_id) from installments
--   where paid_at is not null and paid_at::date >= (due_date + interval '30 days')::date;
-- ============================================================================
