-- 0148: แก้ "ค่าปรับค้าง" (v_contract_status.penalty_due) ให้หักค่าปรับที่เก็บไปแล้ว + ไม่กรองงวดจ่ายครบทิ้ง
--       (คุณเตยอนุมัติแล้ว — เทียบผลกระทบกับ PJ เสร็จ + ลงเงินที่ร้านเก็บไปแล้ว 45 ราย 10,623 บาทเข้าระบบแล้ว)
--
-- ============================================================================
-- ปัญหาเดิม (นิยามที่ apply จริงอยู่ตอนนี้ มาจาก 0133 — ยึด definition นี้เป็นฐาน ไม่ใช่ 0145 ที่ยังไม่ apply):
--   penalty_due = coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0)
--
--   (ก) filter (where i.paid_at is null) ตัดงวดที่จ่าย "เงินต้น" ครบไปแล้วทิ้งจากผลรวม — แต่ค่าปรับกับเงินต้น
--       เป็นคนละก้อนกัน (ดู 0034 penalty split) งวดที่ปิดเงินต้นแล้วอาจยังมีค่าปรับค้างอยู่จริง → ค่าปรับก้อนนั้น
--       หายจากทุกตัวเลขที่อิง penalty_due (การ์ดยอดค้าง, จดหมายทวงหนี้, คิว/exec)
--   (ข) ไม่หัก "ค่าปรับที่เก็บไปแล้วบางส่วน" ออกจาก penalty_amount ดิบ → ค่าปรับที่ร้าน/พนักงานเก็บไปแล้วบาง
--       ส่วน (บันทึกผ่าน payment_log) ยังถูกนับเป็นค้างเต็มจำนวนเดิม → จดหมายทวงหนี้ทวงซ้ำ (พบจริง 3-4 ราย)
--
-- นิยามใหม่ (แบมสเปค, อนุมัติโดยคุณเตย):
--   penalty_due = sum( greatest(0, coalesce(i.penalty_amount,0) − penalty_paid_for_installment(i.id)) )
--   คิดทุกงวดของสัญญา ไม่กรอง paid_at อีกต่อไป — ใช้ public.penalty_paid_for_installment(uuid) ที่มีอยู่แล้ว
--   จาก 0115 (cancel-aware: cancel reset, pay สะสม, edit ไม่มีผล — mirror src/lib/calc.ts
--   penaltyPaidForInstallment ตัวเดียวกับที่ 0131 close_contract_early_preserve_schedule ใช้อยู่แล้วที่บรรทัด
--   181 ของไฟล์นั้น) — "ห้ามเขียนสูตรหักเอง" ใช้ function ตัวเดิมตรงๆ ตาม pattern
--
-- ผลกระทบที่คาดไว้ (ครีมคำนวณเทียบ PJ ไว้ก่อน apply): sum(penalty_due) ของสัญญา active+returned
--   ควรขยับจาก ~318,500 → ~419,475 (เพิ่มขึ้น ~100,975 — ค่าปรับของงวดที่จ่ายเงินต้นครบแล้วแต่ยังค้างค่าปรับ
--   ที่เคยหายไปจากตัวเลข ตอนนี้กลับมานับรวมถูกต้อง) ดู verify block ท้ายไฟล์
--
-- ผลข้างเคียงที่ทราบแล้ว (ไม่ใช่บั๊กใหม่ ไม่อยู่ใน scope คำขอนี้ — เขียนไว้กันงง):
--   สัญญา status='closed' ที่ปิดผ่าน settle_contract_early (0131, "คงตารางงวด" — ห้าม UPDATE installments)
--   จะยังมีงวดที่ paid_at is null ค้างอยู่ในตารางเหมือนตอน active งวดที่ "ไม่ใช่" งวด anchor (v_anchor_id)
--   จะไม่เคยมี payment_log ผูกกับ installment_id ของมันเอง (เงินค่าปรับถูกบันทึกรวมไว้ที่ anchor เพียงงวด
--   เดียวตาม 0131) → penalty_paid_for_installment ของงวดพวกนั้นคืน 0 เสมอ → ค่าปรับงวดนั้นยังโชว์ค้างแบบ raw
--   เหมือนเดิมทั้งก่อน/หลัง migration นี้ (ไม่ได้แย่ลง ไม่ได้ดีขึ้น) ส่วนงวด anchor เองจะถูกหักลงมาก (มักเป็น 0)
--   เพราะ p_penalty_received ที่เก็บตอนปิดมักครอบคลุมค่าปรับรวมของทุกงวดอยู่แล้ว — สุทธิแล้วค่าปรับรวมของ
--   สัญญากลุ่มนี้อาจ "ลดลง" เล็กน้อยจากที่เคยโชว์ ไม่ใช่เพิ่มขึ้น ไม่กระทบตัวเลข active/returned ที่ใช้ verify
--   ด้านล่าง (ตัวเลข ~100,975 คำนวณเฉพาะ active+returned เท่านั้น)
--
-- ⚠️ ประเมิน performance: penalty_paid_for_installment เป็น plpgsql function ที่ query payment_log
--   ข้างในเอง (2 statement/call) — ถ้าเรียกทุกแถวของ ~30,000 งวดทั้งฐานทุกครั้งที่เปิดหน้า /overdue /letters
--   /queue จะช้าขึ้นชัดเจน (เดิม 0 function call เลย เพราะ sum ตรงจาก penalty_amount ดิบ)
--   แก้โดยเรียก function เฉพาะงวดที่ "มีค่าปรับตั้งไว้จริง" (i.penalty_amount > 0) เท่านั้น — งวดที่ไม่เคยมี
--   ค่าปรับ (ส่วนใหญ่ของ 30,000 แถว) greatest(0, 0 − x) = 0 เสมอไม่ว่า x จะเป็นอะไร ไม่ต้องเรียก function
--   เลยก็ได้ผลเหมือนกันทุกกรณี (ไม่ใช่การประมาณ เป็นสมการที่เท่ากันเป๊ะ) — ตัด function call เหลือแค่งวดที่
--   เคยถูก assess ค่าปรับจริง (คาดว่าเป็นเศษส่วนเล็กของ 30,000 ไม่ใช่ทั้งหมด)
--   ⚠️ ถ้า apply แล้วพบว่าหน้า /overdue /letters /queue โหลดช้าลงชัดเจน (ครีมวัดเวลาก่อน/หลัง) ทางเลือกถัดไป
--   คือเปลี่ยนจาก per-row function call เป็น join แบบ aggregate ตรงจาก payment_log ครั้งเดียว
--   (CTE: last_cancel ต่อ installment_id จาก max(created_at) where action='cancel', แล้ว join กลับมา sum
--   penalty_paid_amount ของแถว action='pay' ที่ created_at > last_cancel_at กลุ่มด้วย installment_id)
--   ข้อดี: scan payment_log ครั้งเดียวทั้งก้อน ไม่ loop เรียก function ต่อแถว เร็วกว่าแน่ๆ เมื่อข้อมูลโตขึ้น
--   ข้อเสีย: ต้อง copy logic ของ penalty_paid_for_installment มาเขียนซ้ำเป็น SQL ตรงๆ ในตัว view เอง
--   (ผิดกฎ "ห้ามเขียนสูตรหักเอง" ของคำขอนี้ + เสี่ยง logic 2 ที่ไม่ sync กันถ้าแก้ function ในอนาคต) — ไม่ทำตอนนี้
--   เพราะยังไม่มีหลักฐานว่าจำเป็น รอครีมวัดเวลาจริงหลัง apply ก่อน ถ้าช้าเกินไปค่อยพิจารณาทางเลือกนี้
--
-- ⚠️ ห้ามแตะคอลัมน์อื่นของ view เด็ดขาดตามคำสั่ง — copy CTE oldest_unpaid/latest_return + select ทั้งชุดจาก
--   0133 มาเป๊ะ แก้เฉพาะบรรทัด penalty_due ใน CTE agg เท่านั้น (collectible_remaining, days_late, bucket,
--   overdue_amount, late_installments, next_due, est_outstanding, grade ต้องเหมือนเดิมทุกตัวอักษร)
--
-- หมายเหตุด้าน security: ใช้ CREATE OR REPLACE เพื่อคง grant + security_invoker=on (freelancer RLS ต้องการ
--   security_invoker=on — จาก 0018, คง grant จาก 0049/0055/0090/0126/0128/0130/0133) — penalty_paid_for_
--   installment เป็น security definer (0115) รัน query payment_log ด้วยสิทธิ์ผู้สร้าง function เอง ไม่ผูกกับ
--   security_invoker ของ view จึงไม่มีปัญหา RLS บัง freelancer

create or replace view public.v_contract_status
  with (security_invoker = on) as
with agg as (
  select
    i.contract_id,
    min(i.due_date) filter (where i.paid_at is null)                        as next_due,
    -- 0148: penalty_due ใหม่ — คิดทุกงวด (ไม่กรอง paid_at) หักค่าปรับที่เก็บไปแล้วออกก่อน
    --   (public.penalty_paid_for_installment, cancel-aware, mig 0115 — pattern เดียวกับ 0131 บรรทัด 181)
    --   เรียก function เฉพาะงวดที่ penalty_amount > 0 เท่านั้น (ลด function call — ดูเหตุผล performance
    --   ด้านบน สมการเทียบเท่ากันเป๊ะ ไม่ใช่การประมาณ)
    coalesce(
      sum(
        case
          when coalesce(i.penalty_amount, 0) > 0
            then greatest(0::numeric, i.penalty_amount - public.penalty_paid_for_installment(i.id))
          else 0::numeric
        end
      ),
      0::numeric
    )                                                                        as penalty_due,
    count(*) filter (where i.paid_at is null)                               as remaining_installments,
    -- ยอดงวดที่เลยกำหนดและยังไม่ชำระ (principal คงค้าง = amount - paid_amount)
    coalesce(
      sum(i.amount - coalesce(i.paid_amount, 0))
        filter (where i.paid_at is null and i.due_date <= current_date),
      0::numeric
    )                                                                        as overdue_principal,
    -- 0126: งวดที่จ่ายครบแล้ว (paid_at is not null = จ่ายครบเต็มจำนวน)
    count(*) filter (where i.paid_at is not null)                           as paid_installments_count,
    -- 0126: ยอดเงินต้นที่จ่ายแล้วรวม (รวมงวดจ่ายบางส่วน ไม่รวมค่าปรับ)
    coalesce(sum(i.paid_amount), 0::numeric)                                as paid_amount_sum,
    -- 0126: งวดที่เลยกำหนดและยังไม่จ่ายครบ (ไม่นับปรับ suppress ที่ชั้น select เหมือน overdue_amount)
    count(*) filter (where i.paid_at is null and i.due_date < current_date) as late_installments_count
  from installments i
  group by i.contract_id
),
-- งวดค้างเก่าสุดต่อสัญญา (1 งวด) — mirror v_device_return_report เป๊ะ เพื่อให้ collectible_remaining ตรงกัน
-- 0133: เพิ่ม due_date เพื่อเทียบกับวันคืนเครื่อง (ไม่แตะ — copy เป๊ะจาก 0133)
oldest_unpaid as (
  select distinct on (i.contract_id)
         i.contract_id,
         i.due_date                                          as oldest_unpaid_due_date,
         greatest(i.amount - coalesce(i.paid_amount, 0), 0) as oldest_unpaid_amount,
         coalesce(i.penalty_amount, 0)                       as oldest_unpaid_penalty
  from installments i
  where i.paid_at is null
  order by i.contract_id, i.due_date asc
),
-- แถว device_returns ล่าสุดต่อสัญญา (case_no 1/2/3 → เอาอันใหม่สุด) — mirror v_device_return_report (ไม่แตะ)
latest_return as (
  select distinct on (dr.contract_id)
         dr.contract_id,
         dr.created_at as return_date,
         dr.repair_cost,
         dr.repair_fee
  from device_returns dr
  order by dr.contract_id, dr.created_at desc
)
select
  c.id                                                                       as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name                                                                     as shop_name,
  c.status,
  a.next_due,
  coalesce(a.remaining_installments, 0)                                      as remaining_installments,
  coalesce(a.penalty_due, 0)                                                 as penalty_due,
  -- days_late: suppress เป็น 0 เมื่อรอเอกสาร (pending_documents) หรือปิดจบแล้ว (ไม่แตะ — copy เป๊ะจาก 0133)
  case
    when c.pending_documents = true                             then 0
    when c.status not in ('active','returned') or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end                                                                        as days_late,
  -- bucket: suppress เป็น 'normal' เมื่อรอเอกสาร หรือปิดจบแล้ว (ไม่แตะ — copy เป๊ะจาก 0133)
  case
    when c.pending_documents = true                             then 'normal'
    when c.status not in ('active','returned') or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10                        then '1-10'
    when current_date - a.next_due <= 30                        then '11-30'
    when current_date - a.next_due <= 60                        then '31-60'
    when current_date - a.next_due <= 90                        then '61-90'
    when current_date - a.next_due <= 120                       then '91-120'
    else '120+'
  end                                                                        as bucket,
  -- grade: ใช้ days_late ที่คำนวณแล้ว (ไม่แตะ — copy เป๊ะจาก 0133)
  grade_for_days_late(
    case
      when c.pending_documents = true                             then 0
      when c.status not in ('active','returned') or a.next_due is null then 0
      else greatest(0, (current_date - a.next_due))
    end
  )                                                                          as grade,
  -- est_outstanding: ไม่แตะ — copy เป๊ะจาก 0133
  coalesce(c.monthly_payment, 0) * coalesce(a.remaining_installments, 0)   as est_outstanding,
  -- overdue_amount: ไม่แตะ — copy เป๊ะจาก 0133
  case
    when c.pending_documents = true                             then 0::numeric
    when c.status not in ('active','returned') or a.next_due is null then 0::numeric
    else coalesce(a.overdue_principal, 0::numeric)
  end                                                                        as overdue_amount,
  -- paid_installments — ไม่แตะ — copy เป๊ะจาก 0133
  coalesce(a.paid_installments_count, 0)                                     as paid_installments,
  -- paid_amount_total — ไม่แตะ — copy เป๊ะจาก 0133
  coalesce(a.paid_amount_sum, 0::numeric)                                    as paid_amount_total,
  -- late_installments — ไม่แตะ — copy เป๊ะจาก 0133
  case
    when c.pending_documents = true                             then 0
    when c.status not in ('active','returned') or a.next_due is null then 0
    else coalesce(a.late_installments_count, 0)
  end                                                                        as late_installments,
  -- เลขที่ INV / รุ่นเครื่อง / ความจุ / จำนวนเดือนในสัญญา — ไม่แตะ — copy เป๊ะจาก 0133
  c.inv_no                                                                   as inv_no,
  c.model                                                                    as model,
  c.storage                                                                  as storage,
  c.term_months                                                              as term_months,
  -- ยอดตามเก็บจริงของเคสคืนเครื่อง — ไม่แตะสูตรเลยแม้แต่ตัวอักษรเดียว — copy เป๊ะจาก 0133
  case
    when c.status in ('returned', 'returned_closed') then
      case
        when lr.return_date is not null
          and (lr.return_date at time zone 'Asia/Bangkok')::date >= '2026-07-02'::date
          and ou.oldest_unpaid_due_date is not null
          and ou.oldest_unpaid_due_date > (lr.return_date at time zone 'Asia/Bangkok')::date
        then 0
        else coalesce(ou.oldest_unpaid_amount, 0) + coalesce(ou.oldest_unpaid_penalty, 0)
      end
        + coalesce(lr.repair_cost, lr.repair_fee, 0)
    else null
  end                                                                        as collectible_remaining
from contracts c
left join agg a           on a.contract_id = c.id
left join shops_basic s   on s.id = c.shop_id
left join oldest_unpaid ou on ou.contract_id = c.id
left join latest_return lr on lr.contract_id = c.id;

-- CREATE OR REPLACE คง grant เดิมจาก 0049/0055/0090/0126/0128/0130/0133 อยู่แล้ว แต่ใส่ไว้เพื่อความปลอดภัย
-- (กรณีที่ Postgres reset grants ตอน replace — ป้องกัน Edge Function เจอ 42501)
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply (ห้ามข้าม — โดยเฉพาะข้อ 4/5 กันคอลัมน์อื่นเปลี่ยนโดยไม่ตั้งใจ)
-- ============================================================================

-- 0) ก่อน apply: ยืนยัน definition ที่ live อยู่จริงตรงกับที่ migration นี้ใช้เป็นฐาน (ต้องเห็นบรรทัด
--    "coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0)" เป็น penalty_due เดิม
--    และเห็น collectible_remaining gate ของ 0133 อยู่แล้ว ไม่ใช่ของ 0145):
-- SELECT pg_get_viewdef('public.v_contract_status'::regclass, true);

-- 1) columns ยังครบ 22 ตัวเท่าเดิม ลำดับเดิมเป๊ะ (ไม่เพิ่ม/ลด column):
-- SELECT column_name, ordinal_position
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'v_contract_status'
--   ORDER BY ordinal_position;
-- expected: 22 แถว, ตัวสุดท้าย collectible_remaining (pos 22)

-- 2) security_invoker ยังคงเปิด + grants ครบ:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_contract_status', 'SELECT');
-- expected: security_invoker=on ใน reloptions, has_table_privilege ทั้งคู่ = true

-- 3) ผลกระทบหลัก — sum(penalty_due) ของ active+returned ต้องขยับขึ้น ~100,975 (318,500 → ~419,475):
-- SELECT status, count(*) AS n, sum(penalty_due) AS total_penalty_due
--   FROM public.v_contract_status
--   WHERE status IN ('active','returned')
--   GROUP BY status
--   ORDER BY status;
-- (รันเทียบกับตัวเลขที่บันทึกไว้ก่อน apply ด้วยคำสั่งเดียวกัน — ต้องเห็นผลรวมเพิ่มขึ้นเท่านั้น ไม่ใช่ลดลง)

-- 4) กันคอลัมน์อื่นเปลี่ยนโดยไม่ตั้งใจ — เทียบทุกคอลัมน์ยกเว้น penalty_due ก่อน/หลัง apply ต้องเหมือนเดิม 100%
--    (รันก่อน apply เก็บผลไว้ก่อน แล้วรันซ้ำหลัง apply เทียบ):
-- SELECT contract_id, contract_no, status, next_due, remaining_installments, days_late, bucket, grade,
--        est_outstanding, overdue_amount, paid_installments, paid_amount_total, late_installments,
--        inv_no, model, storage, term_months, collectible_remaining
--   FROM public.v_contract_status
--   ORDER BY contract_id;

-- 5) collectible_remaining ของเคสคืนเครื่อง ต้องไม่ขยับแม้แต่บาทเดียว (สุ่มเช็คเคสเดิมจาก 0130/0133 smoke):
-- SELECT contract_no, status, collectible_remaining
--   FROM public.v_contract_status
--   WHERE contract_no IN ('S00015PNQ050', 'S00015PNQ128', 'S00025PNQ34');
-- expected: ค่าเท่าเดิมทุกตัว (S00015PNQ050=3122, S00015PNQ128=2712, S00025PNQ34=0)

-- 6) เทียบ v_contract_status กับ v_device_return_report ต้องยังตรงกันทุกเคส returned/returned_closed
--    (0148 ไม่ได้แตะ v_device_return_report เลย — เช็คซ้ำกันพลาด):
-- SELECT vcs.contract_no, vcs.collectible_remaining AS vcs_val, vdr.collectible_remaining AS vdr_val
--   FROM public.v_contract_status vcs
--   JOIN public.v_device_return_report vdr ON vdr.contract_id = vcs.contract_id
--   WHERE vcs.collectible_remaining IS DISTINCT FROM vdr.collectible_remaining;
-- expected: 0 rows

-- 7) smoke เคสที่เจอทวงซ้ำจริง (ค่าปรับเก็บไปแล้วบางส่วนแต่ยังโชว์ค้างเต็ม) — หา contract ตัวอย่างมาเช็คมือ:
-- SELECT i.id, i.contract_id, i.installment_no, i.penalty_amount, i.paid_at,
--        public.penalty_paid_for_installment(i.id) AS penalty_already_paid,
--        greatest(0, coalesce(i.penalty_amount,0) - public.penalty_paid_for_installment(i.id)) AS penalty_net
--   FROM public.installments i
--   WHERE i.penalty_amount > 0
--   ORDER BY i.contract_id, i.installment_no
--   LIMIT 50;
-- expected: เห็นบางแถวที่ penalty_already_paid > 0 และ penalty_net < penalty_amount (เคสที่เคยทวงซ้ำ)

-- 8) วัด performance เทียบก่อน/หลัง (คร่าวๆ ด้วย EXPLAIN ANALYZE) — ถ้าช้าเกินคาด พิจารณา join-aggregate
--    alternative ที่เขียนอธิบายไว้ในคอมเมนต์ต้นไฟล์:
-- EXPLAIN ANALYZE SELECT * FROM public.v_contract_status;
