-- ============================================================================
-- Phase 3 (ต่อ) — ปรับ view สถานะให้มีข้อมูลครบสำหรับหน้า dashboard
-- ก๊อปไปวางใน SQL Editor หลังรัน 0003
-- ============================================================================

-- drop ก่อน เพราะเปลี่ยนคอลัมน์ (create or replace เปลี่ยนชื่อ/ลำดับคอลัมน์ไม่ได้)
drop view if exists v_contract_status;

create view v_contract_status as
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
  c.id as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name as shop_name,
  c.status,
  a.next_due,
  coalesce(a.remaining_installments, 0) as remaining_installments,
  coalesce(a.penalty_due, 0) as penalty_due,
  case
    when c.status <> 'active' or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end as days_late,
  case
    when c.status <> 'active' or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10 then '1-10'
    when current_date - a.next_due <= 30 then '11-30'
    when current_date - a.next_due <= 60 then '31-60'
    when current_date - a.next_due <= 90 then '61-90'
    when current_date - a.next_due <= 120 then '91-120'
    else '120+'
  end as bucket
from contracts c
left join agg a on a.contract_id = c.id
left join shops s on s.id = c.shop_id;
