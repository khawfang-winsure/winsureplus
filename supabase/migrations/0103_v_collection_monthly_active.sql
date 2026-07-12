-- 0103: เพิ่ม "มุมเฉพาะสัญญาที่ยังผ่อนอยู่" ให้กล่องอัตราเก็บเงินย้อนหลัง
-- (/staff-performance) — create or replace view v_collection_monthly
--
-- ============================================================================
-- Pete ต้องการดู 2 มุม:
--   (ก) รวมทุกเคส  = 6 คอลัมน์เดิม (คงไว้เป๊ะ ไม่แตะตรรกะ)
--   (ข) เฉพาะเคสเดินอยู่ = contract.status='active' เท่านั้น
--       (ตัด returned / returned_closed / closed / อื่นๆ ที่จบแล้วออก)
--
-- คอลัมน์ active_* คำนวณจากงวดเดียวกัน (due_date <= current_date) แต่ join
-- contracts แล้วนับเฉพาะแถวที่ contract.status='active'
--   active_total          = จำนวนงวดครบกำหนดของเคส active
--   active_paid           = paid_at IS NOT NULL
--   active_unpaid         = paid_at IS NULL
--   active_collected_baht = ยอดเก็บได้ (บาท) ของเคส active
--   active_pct_collected  = round(100*paid/total) กัน div0 ด้วย nullif
--                           → null ได้ถ้าเดือนนั้นไม่มีเคส active
--
-- คอลัมน์เดิม 6 ตัวคำนวณจาก cohort เดิม (ทุก status) — ไม่เปลี่ยนค่า
-- grant ซ้ำเพราะ replace view (ตาม 0101/0102)
-- ============================================================================

create or replace view public.v_collection_monthly as
with cohort as (
  select date_trunc('month', i.due_date)::date as due_month,
         i.amount,
         (i.paid_at is not null) as is_paid,
         (c.status = 'active')   as is_active
  from public.installments i
  join public.contracts c on c.id = i.contract_id
  where i.due_date <= current_date
)
select due_month,
       -- มุม (ก) รวมทุกเคส (เดิม ห้ามเปลี่ยน)
       count(*)::int                                                     as total_installments,
       count(*) filter (where is_paid)::int                             as paid_installments,
       count(*) filter (where not is_paid)::int                         as unpaid_installments,
       coalesce(round(sum(amount) filter (where is_paid)),0)::bigint     as collected_baht,
       round(100.0 * count(*) filter (where is_paid)
             / nullif(count(*),0))::int                                  as pct_collected,
       -- มุม (ข) เฉพาะเคสเดินอยู่ (status='active')
       count(*) filter (where is_active)::int                           as active_total,
       count(*) filter (where is_active and is_paid)::int               as active_paid,
       count(*) filter (where is_active and not is_paid)::int           as active_unpaid,
       coalesce(round(sum(amount) filter (where is_active and is_paid)),0)::bigint
                                                                         as active_collected_baht,
       round(100.0 * count(*) filter (where is_active and is_paid)
             / nullif(count(*) filter (where is_active),0))::int        as active_pct_collected
from cohort
group by due_month
order by due_month;

grant select on public.v_collection_monthly to authenticated, service_role;
