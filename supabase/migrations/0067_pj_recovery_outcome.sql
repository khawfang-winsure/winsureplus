-- 0067: views "ตามเก็บได้ vs ยังเก็บไม่ได้ แยกตามเดือนครบกำหนด" (ต่อยอด pj_payment_history)
-- ต่อจาก 0066 — 0066 มองเฉพาะงวดที่จ่ายช้า (recovered) bucket ตามวันจ่าย
-- 0067 เพิ่มมุมมอง cohort ตาม "เดือนครบกำหนด (due_date)": งวดที่ครบกำหนดในเดือนนั้น
--   ตอนนี้ตามเก็บได้แล้วเท่าไร (recovered) vs ยังเก็บไม่ได้เท่าไร (outstanding)

-- ============================================================================
-- นิยาม cohort (ยืนยันกับข้อมูลจริงแล้ว) — กรองแถวค่าปรับออกเหมือน 0066:
--   amount is not null AND (amount > 1200 OR (amount::int % 100) <> 0) AND due_date is not null
--
--   recovered (ตามเก็บได้)  = paid_date is not null AND paid_date > due_date
--                             (เคยจ่ายช้า แต่สุดท้ายจ่ายแล้ว)
--   outstanding (ยังค้าง)    = paid_date is null AND due_date < current_date
--                             (เลยกำหนดแล้วยังไม่จ่าย)
--   bucket ตามเดือนของ due_date (เดือนครบกำหนด — ไม่ใช่ paid_date)
--
-- อัตราสำเร็จ % คำนวณฝั่ง frontend = recovered / (recovered + outstanding)
--
-- pattern grant: ตามโปรเจกต์ (0057/0059/0066) — view ธรรมดา ไม่ใช้ security_invoker
--   create or replace view + grant select to authenticated, service_role
--   (admin gate ทำที่ frontend/route; pj_payment_history มี RLS admin-only อยู่แล้ว)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) รายเดือนครบกำหนด — ตามเก็บได้ vs ยังเก็บไม่ได้
-- ----------------------------------------------------------------------------
create or replace view public.v_pj_recovery_outcome_monthly as
with cohort as (
  select due_date, amount, paid_date,
    case when paid_date is not null and paid_date > due_date then 'recovered'
         when paid_date is null and due_date < current_date then 'outstanding' end as outcome
  from public.pj_payment_history
  where amount is not null and (amount > 1200 or (amount::int % 100) <> 0) and due_date is not null
)
select to_char(date_trunc('month', due_date),'YYYY-MM') as due_month,
  count(*) filter (where outcome='recovered')                                  as recovered_installments,
  coalesce(round(sum(amount) filter (where outcome='recovered')),0)::bigint    as recovered_baht,
  count(*) filter (where outcome='outstanding')                                as outstanding_installments,
  coalesce(round(sum(amount) filter (where outcome='outstanding')),0)::bigint  as outstanding_baht
from cohort
where outcome is not null
group by 1 order by 1;

-- ----------------------------------------------------------------------------
-- 2) สรุปรวม (1 แถว) — ตามเก็บได้ vs ยังเก็บไม่ได้ ทั้งพอร์ต
-- ----------------------------------------------------------------------------
create or replace view public.v_pj_recovery_outcome_summary as
with cohort as (
  select amount, paid_date, due_date,
    case when paid_date is not null and paid_date > due_date then 'recovered'
         when paid_date is null and due_date < current_date then 'outstanding' end as outcome
  from public.pj_payment_history
  where amount is not null and (amount > 1200 or (amount::int % 100) <> 0) and due_date is not null
)
select
  count(*) filter (where outcome='recovered')                                  as recovered_installments,
  coalesce(round(sum(amount) filter (where outcome='recovered')),0)::bigint    as recovered_baht,
  count(*) filter (where outcome='outstanding')                                as outstanding_installments,
  coalesce(round(sum(amount) filter (where outcome='outstanding')),0)::bigint  as outstanding_baht
from cohort where outcome is not null;

-- ============================================================================
-- GRANT — views ต้อง grant ตรง (0017 default privileges ไม่ครอบ views)
-- re-grant idempotent หลัง create or replace (ตาม pattern 0057/0059/0066)
-- ============================================================================
grant select on public.v_pj_recovery_outcome_monthly to authenticated, service_role;
grant select on public.v_pj_recovery_outcome_summary  to authenticated, service_role;

-- ============================================================================
-- Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================
-- a) grants ครบ:
--   select has_table_privilege('authenticated','public.v_pj_recovery_outcome_monthly','SELECT');  -- true
--   select has_table_privilege('service_role','public.v_pj_recovery_outcome_summary','SELECT');   -- true
--
-- b) สรุปรวม (recovered + outstanding):
--   select * from v_pj_recovery_outcome_summary;
--
-- c) รายเดือนครบกำหนด เรียงตามเดือน:
--   select * from v_pj_recovery_outcome_monthly;
--
-- d) ผลรวมรายเดือนต้องตรงกับสรุปรวม:
--   select sum(recovered_installments)   as r_inst, sum(recovered_baht)   as r_baht,
--          sum(outstanding_installments) as o_inst, sum(outstanding_baht) as o_baht
--   from v_pj_recovery_outcome_monthly;
--   -- เทียบกับ v_pj_recovery_outcome_summary แต่ละคอลัมน์
