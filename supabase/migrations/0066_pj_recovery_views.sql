-- 0066: views รายงาน "การตามหนี้ย้อนหลังจาก PJ" (pj_payment_history → 4 aggregate views)
-- ใช้สำหรับหน้ารายงานผู้บริหาร (admin) — สรุปเงินที่ตามกลับมาได้จากงวดที่จ่ายช้า

-- ============================================================================
-- นิยาม "เงินตามกลับมาได้ (recovered)"
--   = งวดที่จ่ายช้า (is_late) และ "ไม่ใช่แถวค่าปรับ"
--   แถวค่าปรับ = amount <= 1200 และเป็นพหุคูณของ 100
--   → filter ทุก view: is_late AND amount IS NOT NULL
--                       AND (amount > 1200 OR (amount::int % 100) <> 0)
--
-- pattern grant: ตามโปรเจกต์ (0057/0059) — view ธรรมดา ไม่ใช้ security_invoker
--   create or replace view + grant select to authenticated, service_role
--   (admin gate ทำที่ frontend/route เหมือน v_clawback_status; pj_payment_history
--    เองมี RLS admin-only อยู่แล้ว แต่ view ไม่สืบ RLS — รายงานนี้เปิดให้ authenticated
--    อ่าน aggregate ได้ ตาม pattern view อื่นในโปรเจกต์ ซึ่งล้วน grant authenticated)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) สรุปรวม (1 แถว)
-- ----------------------------------------------------------------------------
create or replace view public.v_pj_recovery_summary as
select count(distinct contract_id) as late_contracts,
       count(*)                    as late_installments,
       coalesce(round(sum(amount)),0)::bigint as recovered_total,
       coalesce(round(avg(days_late)),0)::int as avg_days_late,
       coalesce(max(days_late),0)            as max_days_late
from public.pj_payment_history
where is_late and amount is not null and (amount > 1200 or (amount::int % 100) <> 0);

-- ----------------------------------------------------------------------------
-- 2) รายเดือน (ตามวันจ่ายจริง)
-- ----------------------------------------------------------------------------
create or replace view public.v_pj_recovery_monthly as
select to_char(date_trunc('month', paid_date),'YYYY-MM') as month,
       count(*) as installments,
       count(distinct contract_id) as contracts,
       round(sum(amount))::bigint as recovered_baht
from public.pj_payment_history
where is_late and amount is not null and (amount > 1200 or (amount::int % 100) <> 0)
group by 1 order by 1;

-- ----------------------------------------------------------------------------
-- 3) แยกพนักงาน (join debtflow_cases.assigned_employee ด้วย contract_id)
--    ครอบคลุมเฉพาะเคสที่อยู่ใน DEBTFLOW (มี contract_id แมตช์)
-- ----------------------------------------------------------------------------
create or replace view public.v_pj_recovery_by_employee as
select coalesce(nullif(trim(d.assigned_employee),''),'(ไม่ระบุ)') as employee,
       count(distinct p.contract_id) as contracts,
       count(*)                      as late_installments,
       round(sum(p.amount))::bigint  as recovered_baht,
       coalesce(round(avg(p.days_late)),0)::int as avg_days_late
from public.pj_payment_history p
join public.debtflow_cases d on d.contract_id = p.contract_id
where p.is_late and p.amount is not null and (p.amount > 1200 or (p.amount::int % 100) <> 0)
group by 1 order by recovered_baht desc;

-- ----------------------------------------------------------------------------
-- 4) การกระจายวันช้า (เฉพาะงวด recovery)
-- ----------------------------------------------------------------------------
create or replace view public.v_pj_days_late_dist as
select case when days_late between 1 and 7 then '1-7'
            when days_late between 8 and 30 then '8-30'
            when days_late between 31 and 60 then '31-60'
            when days_late between 61 and 90 then '61-90'
            else '90+' end as bucket,
       count(*) as installments,
       count(distinct contract_id) as contracts
from public.pj_payment_history
where is_late and amount is not null and (amount > 1200 or (amount::int % 100) <> 0)
group by 1;

-- ============================================================================
-- GRANT — views ต้อง grant ตรง (0017 default privileges ไม่ครอบ views)
-- re-grant idempotent หลัง create or replace (ตาม pattern 0057/0059)
-- ============================================================================
grant select on public.v_pj_recovery_summary     to authenticated, service_role;
grant select on public.v_pj_recovery_monthly      to authenticated, service_role;
grant select on public.v_pj_recovery_by_employee  to authenticated, service_role;
grant select on public.v_pj_days_late_dist         to authenticated, service_role;

-- ============================================================================
-- Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================
-- a) grants ครบ:
--   select has_table_privilege('authenticated','public.v_pj_recovery_summary','SELECT');     -- true
--   select has_table_privilege('service_role','public.v_pj_recovery_by_employee','SELECT');  -- true
--
-- b) สรุปรวม:
--   select * from v_pj_recovery_summary;
--   -- late_contracts/late_installments/recovered_total/avg_days_late/max_days_late
--
-- c) รายเดือนเรียงตามเดือน:
--   select * from v_pj_recovery_monthly;
--
-- d) แยกพนักงาน (เฉพาะเคสใน DEBTFLOW):
--   select * from v_pj_recovery_by_employee;
--
-- e) bucket วันช้า (ผลรวม installments ต้องตรง late_installments ใน summary):
--   select * from v_pj_days_late_dist order by 1;
--   select sum(installments) from v_pj_days_late_dist;  -- = v_pj_recovery_summary.late_installments
