-- 0101: กล่อง "ผลการตามหนี้จริง" ในหน้า /staff-performance คำนวณสดจากงวดผ่อนในเว็บเรา
-- แทนการอ่าน snapshot pj_payment_history (import เป็นรอบ ไม่เรียลไทม์)
-- สร้าง view ใหม่ v_recovery_* (ไม่ทับ v_pj_recovery_* เดิม เผื่อ Pete เทียบย้อนหลัง/rollback)
--
-- ============================================================================
-- แหล่งข้อมูลใหม่ = ตาราง installments (งวดผ่อนจริงในเว็บเรา) — realtime
--   1 แถว = 1 งวด (ไม่ปนแถวค่าปรับเหมือน pj_payment_history จึงไม่ต้อง filter แถว 100/200)
--
-- นิยาม (ตรงกับ view เดิม 0066/0067 แต่แหล่งข้อมูลเปลี่ยน):
--   paid_d (วันจ่ายจริง) = (paid_at at time zone 'Asia/Bangkok')::date
--     — canonical tz ของแอป; PJ-sync ตั้ง paid_at เป็น UTC-midnight, web ตั้ง now()
--       ทั้งสองแบบแปลงเป็นวันตามเวลาไทยได้ตรง
--   recovered (ตามเก็บได้จริง) = paid_at IS NOT NULL AND paid_d > due_date
--     (งวดที่จ่าย "หลังเลยวันครบกำหนด" = เก็บกลับมาได้)
--   days_late = paid_d - due_date
--   outstanding (ยังเก็บไม่ได้) = paid_at IS NULL AND due_date < current_date
--
-- คอลัมน์ output เหมือน view เดิมเป๊ะ (ชื่อ+ชนิด) → frontend/db.ts ไม่ต้องแก้ mapping
--   (view เดิมทั้ง 5 ตัวเป็น aggregate ทั้งพอร์ต ไม่มีมิติรายพนักงานอยู่แล้ว —
--    v_pj_recovery_by_employee เป็นคนละ view กล่องนี้ไม่ได้ใช้ จึงไม่แตะ)
--
-- pattern grant: view ธรรมดา (ตาม 0057/0059/0066/0067) — grant select authenticated, service_role
--   admin gate ทำที่ frontend/route เหมือนเดิม
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) สรุปรวมการตามเก็บได้จริง (1 แถว) — แทน v_pj_recovery_summary
-- ----------------------------------------------------------------------------
create or replace view public.v_recovery_summary as
with recovered as (
  select contract_id,
         amount,
         ((paid_at at time zone 'Asia/Bangkok')::date - due_date) as days_late
  from public.installments
  where paid_at is not null
    and (paid_at at time zone 'Asia/Bangkok')::date > due_date
)
select count(distinct contract_id)                as late_contracts,
       count(*)                                   as late_installments,
       coalesce(round(sum(amount)),0)::bigint     as recovered_total,
       coalesce(round(avg(days_late)),0)::int     as avg_days_late,
       coalesce(max(days_late),0)::int            as max_days_late
from recovered;

-- ----------------------------------------------------------------------------
-- 2) เงินตามกลับรายเดือน (ตามวันจ่ายจริง) — แทน v_pj_recovery_monthly
-- ----------------------------------------------------------------------------
create or replace view public.v_recovery_monthly as
with recovered as (
  select contract_id, amount,
         (paid_at at time zone 'Asia/Bangkok')::date as paid_d, due_date
  from public.installments
  where paid_at is not null
    and (paid_at at time zone 'Asia/Bangkok')::date > due_date
)
select to_char(date_trunc('month', paid_d),'YYYY-MM') as month,
       count(*)                                        as installments,
       count(distinct contract_id)                     as contracts,
       coalesce(round(sum(amount)),0)::bigint          as recovered_baht
from recovered
group by 1 order by 1;

-- ----------------------------------------------------------------------------
-- 3) การกระจายวันช้า (เฉพาะงวด recovery) — แทน v_pj_days_late_dist
-- ----------------------------------------------------------------------------
create or replace view public.v_recovery_days_late_dist as
with recovered as (
  select contract_id,
         ((paid_at at time zone 'Asia/Bangkok')::date - due_date) as days_late
  from public.installments
  where paid_at is not null
    and (paid_at at time zone 'Asia/Bangkok')::date > due_date
)
select case when days_late between 1 and 7  then '1-7'
            when days_late between 8 and 30 then '8-30'
            when days_late between 31 and 60 then '31-60'
            when days_late between 61 and 90 then '61-90'
            else '90+' end            as bucket,
       count(*)                       as installments,
       count(distinct contract_id)    as contracts
from recovered
group by 1;

-- ----------------------------------------------------------------------------
-- 4) รายเดือนครบกำหนด — ตามเก็บได้ vs ยังเก็บไม่ได้ (cohort ตาม due_date)
--    แทน v_pj_recovery_outcome_monthly
-- ----------------------------------------------------------------------------
create or replace view public.v_recovery_outcome_monthly as
with cohort as (
  select due_date, amount,
    case when paid_at is not null
              and (paid_at at time zone 'Asia/Bangkok')::date > due_date then 'recovered'
         when paid_at is null and due_date < current_date then 'outstanding' end as outcome
  from public.installments
)
select to_char(date_trunc('month', due_date),'YYYY-MM')                          as due_month,
  count(*) filter (where outcome='recovered')                                    as recovered_installments,
  coalesce(round(sum(amount) filter (where outcome='recovered')),0)::bigint      as recovered_baht,
  count(*) filter (where outcome='outstanding')                                  as outstanding_installments,
  coalesce(round(sum(amount) filter (where outcome='outstanding')),0)::bigint    as outstanding_baht
from cohort
where outcome is not null
group by 1 order by 1;

-- ----------------------------------------------------------------------------
-- 5) สรุปรวม ตามเก็บได้ vs ยังเก็บไม่ได้ (1 แถว) — แทน v_pj_recovery_outcome_summary
-- ----------------------------------------------------------------------------
create or replace view public.v_recovery_outcome_summary as
with cohort as (
  select due_date, amount,
    case when paid_at is not null
              and (paid_at at time zone 'Asia/Bangkok')::date > due_date then 'recovered'
         when paid_at is null and due_date < current_date then 'outstanding' end as outcome
  from public.installments
)
select
  count(*) filter (where outcome='recovered')                                    as recovered_installments,
  coalesce(round(sum(amount) filter (where outcome='recovered')),0)::bigint      as recovered_baht,
  count(*) filter (where outcome='outstanding')                                  as outstanding_installments,
  coalesce(round(sum(amount) filter (where outcome='outstanding')),0)::bigint    as outstanding_baht
from cohort where outcome is not null;

-- ============================================================================
-- GRANT — views ต้อง grant ตรง (0017 default privileges ไม่ครอบ views)
-- re-grant idempotent หลัง create or replace (ตาม pattern 0057/0059/0066/0067)
-- ============================================================================
grant select on public.v_recovery_summary          to authenticated, service_role;
grant select on public.v_recovery_monthly           to authenticated, service_role;
grant select on public.v_recovery_days_late_dist     to authenticated, service_role;
grant select on public.v_recovery_outcome_monthly    to authenticated, service_role;
grant select on public.v_recovery_outcome_summary    to authenticated, service_role;
