-- 0039: สร้าง views รวมยอดต่อสัญญา เพื่อรองรับ 2,400+ สัญญา (แทนการ scan raw rows ทั้งหมด)

-- ============================================================================
-- SECTION 1: v_contract_aggregates — รวมสถิติงวดต่อสัญญา
-- ใช้แทน getAllInstallments() ในหน้า dashboard/ค่าคอม/outstanding
-- ============================================================================

create or replace view public.v_contract_aggregates as
select
  c.id                                                                            as contract_id,
  count(i.id)                                                                     as total_installments,
  count(i.id) filter (where i.paid_at is not null)                               as paid_count,
  count(i.id) filter (where i.paid_at is null and i.due_date < current_date)     as overdue_count,
  coalesce(sum(i.paid_amount)   filter (where i.paid_at is not null), 0)         as total_paid,
  coalesce(sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0))
           filter (where i.paid_at is null), 0)                                  as total_outstanding,
  coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0)            as total_penalty,
  max(i.paid_at)                                                                  as last_paid_at,
  min(i.due_date) filter (where i.paid_at is null)                               as next_due_date
from public.contracts c
left join public.installments i on i.contract_id = c.id
group by c.id;

-- ============================================================================
-- SECTION 2: v_payment_summary — รวมยอดรับชำระต่อสัญญา
-- ใช้แทน getAllPayments() ในหน้า cashflow/กราฟ
-- ============================================================================

create or replace view public.v_payment_summary as
select
  contract_id,
  count(*)          filter (where action = 'pay')                 as pay_count,
  coalesce(sum(amount) filter (where action = 'pay'), 0)          as total_pay,
  max(created_at)   filter (where action = 'pay')                 as last_pay_at
from public.payment_log
group by contract_id;

-- ============================================================================
-- SECTION 3: v_contract_current_address — ที่อยู่ปัจจุบันต่อสัญญา (ล่าสุด)
-- ใช้แทน getAllAddresses() ในหน้าส่งจดหมาย
-- ============================================================================

create or replace view public.v_contract_current_address as
select distinct on (contract_id)
  contract_id,
  house_no,
  moo,
  soi,
  road,
  subdistrict,
  district,
  province,
  postal_code
from public.customer_addresses
where kind = 'current'
order by contract_id, created_at desc;

-- ============================================================================
-- SECTION 4: GRANT — ให้ authenticated + service_role อ่าน views ได้
-- (0017 grant default privileges บน tables ไม่ครอบ views ต้องระบุตรง)
-- ============================================================================

grant select on public.v_contract_aggregates    to authenticated, service_role;
grant select on public.v_payment_summary        to authenticated, service_role;
grant select on public.v_contract_current_address to authenticated, service_role;
