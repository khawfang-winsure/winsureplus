-- 0056: สร้าง v_cashflow_daily — aggregate รายได้รายวันจาก payment_log ทั้งหมด
-- ปัญหาเดิม: ExecDashboard เรียก getAllPayments() ซึ่งติด PAGE_CAP 4,999 แถว
--           payment_log จริงมี 14,621 แถว (action='pay') → รายได้ขาดราว 65%
-- แก้โดย: group by วันที่ฝั่ง DB แทน → view คืน 1 แถวต่อวัน ไม่ติด row limit
-- ฟิลด์:
--   pay_date        date (Asia/Bangkok timezone)
--   income          sum(amount)               ยอดรับรวม (principal + penalty)
--   penalty_income  sum(penalty_paid_amount)  ยอดค่าปรับแยก (เผื่อ breakdown wave ถัดไป)
--   pay_count       count(*)                  จำนวนรายการ

create or replace view public.v_cashflow_daily as
select
  (created_at at time zone 'Asia/Bangkok')::date   as pay_date,
  sum(amount)                                       as income,
  sum(coalesce(penalty_paid_amount, 0))             as penalty_income,
  count(*)                                          as pay_count
from public.payment_log
where action = 'pay'
group by (created_at at time zone 'Asia/Bangkok')::date
order by pay_date;

-- Grant ตาม pattern 0055 — GRANT ทั้ง authenticated + service_role
-- (CREATE OR REPLACE อาจ reset grants บน view ใหม่ ใส่ไว้ explicit ปลอดภัยกว่า)
grant select on public.v_cashflow_daily to authenticated;
grant select on public.v_cashflow_daily to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply
-- ============================================================================

-- 1) ยอดรวมจาก view ต้องตรงกับ payment_log ตรงๆ:
-- SELECT count(*), sum(amount), sum(penalty_paid_amount)
--   FROM public.payment_log WHERE action = 'pay';
-- expected: count=14621 (หรือมากกว่า ณ เวลาที่รัน)

-- SELECT sum(income) as total_income, sum(penalty_income) as total_penalty, sum(pay_count) as total_count
--   FROM public.v_cashflow_daily;
-- expected: total_count ตรง count ด้านบน, total_income และ total_penalty ตรงทุกบาท

-- 2) grants ครบ:
-- SELECT has_table_privilege('authenticated', 'public.v_cashflow_daily', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_cashflow_daily', 'SELECT');
-- expected: true ทั้งคู่
