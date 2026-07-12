-- 0102: กล่อง "อัตราเก็บเงินย้อนหลัง (รายเดือน)" ในหน้า /staff-performance
-- คำนวณสดจากงวดผ่อน (installments) — นับตาม "เดือนที่ครบกำหนด" (due_date)
-- ว่าสุดท้ายเก็บได้กี่งวด/กี่บาท (จ่ายแล้ว vs ยังค้าง)
--
-- ============================================================================
-- ทำไมกล่องนี้ ≠ v_recovery_* (mig 0101):
--   v_recovery_* พึ่ง (paid_at > due_date) เพื่อวัด "จ่ายช้าแล้วในที่สุดตามเก็บได้"
--   แต่ paid_at ของงวดย้อนหลังเป็น placeholder (PJ-sync ตั้ง = วันครบกำหนด/UTC-midnight)
--   → วัน "จ่ายช้ากี่วัน" ย้อนหลังเชื่อไม่ได้
--   กล่องนี้เลี่ยงปัญหา: ดูแค่ paid_at IS NULL / NOT NULL (จ่ายแล้ว/ยังค้าง)
--   ซึ่งเชื่อถือได้ทุกช่วงเวลา ไม่พึ่งวันที่จ่าย
--
-- นิยาม cohort ตาม due_date:
--   paid_installments   = paid_at IS NOT NULL (เก็บได้)
--   unpaid_installments = paid_at IS NULL     (ยังค้าง)
-- เงื่อนไขสำคัญ: นับเฉพาะงวดที่ due_date <= current_date
--   (ตัดงวดในอนาคตที่ยังไม่ถึงกำหนด ไม่งั้นจะดูเหมือนค้างทั้งที่ยังไม่ถึงเวลา)
--
-- หมายเหตุ status สัญญา: view นี้นับทุกงวดที่ถึงกำหนด ไม่กรอง contract.status
--   (consistent กับ v_recovery_* เดิม) — เคสปิด/คืนเครื่องที่มีงวดค้างจะถูกนับเป็น "ค้าง"
--
-- grant: view ธรรมดา → grant select authenticated, service_role (ตาม 0101)
-- ============================================================================

create or replace view public.v_collection_monthly as
with cohort as (
  select date_trunc('month', due_date)::date as due_month,
         amount,
         (paid_at is not null) as is_paid
  from public.installments
  where due_date <= current_date
)
select due_month,
       count(*)::int                                                as total_installments,
       count(*) filter (where is_paid)::int                         as paid_installments,
       count(*) filter (where not is_paid)::int                     as unpaid_installments,
       coalesce(round(sum(amount) filter (where is_paid)),0)::bigint as collected_baht,
       round(100.0 * count(*) filter (where is_paid)
             / nullif(count(*),0))::int                             as pct_collected
from cohort
group by due_month
order by due_month;

grant select on public.v_collection_monthly to authenticated, service_role;
