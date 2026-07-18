-- 0116: กติกาค่าปรับใหม่ — นับค่าปรับต่อจนกว่าจะ "จ่ายค่าปรับครบ" ไม่หยุดตอนจ่ายเงินต้น (spec แบม 18 ก.ค. 2026)
--
-- ============================================================================
-- บั๊กเดิม (mig 0031 run_daily_update):
--   penalty recompute (reset-to-zero / คิดค่าปรับงวดเก่าสุด) ใช้เงื่อนไข "paid_at is null" (เงินต้นยังไม่จ่าย)
--   เป็นตัวกรอง "งวดที่ยัง eligible" → พอเงินต้นงวดนั้นถูกจ่ายครบ (paid_at ถูกเซ็ต) penalty_amount ของงวดนั้น
--   จะถูก freeze ทันที แม้ค่าปรับที่เรียกไว้ยังจ่ายไม่ครบจริง (เช่น เรียก 700 จ่ายค่าปรับไปแค่ 200) — เงินต้น
--   กับค่าปรับเป็นคนละมิติกัน ไม่ควรผูกกัน (เห็นชัดจากเคสสุภัสรา 18 ก.ค. 2026 — ดู memory
--   penalty-misapplied-installment-2026-07-18)
--
-- Pete อนุมัติกฎใหม่ (18 ก.ค. 2026, แบมสเปค):
--   ค่าปรับนับต่อจนกว่าจะ "settled" = มี event จ่ายค่าปรับ (payment_log action='pay') ที่ทำให้ยอดค่าปรับจ่าย
--   สะสม ณ วันที่ event นั้นเกิด ทันยอดค่าปรับที่ต้องเรียก ณ วันนั้น (owed-at-event-date) — ไม่ใช่ตอนเงินต้นปิด
--   mirror ฝั่ง TypeScript = src/lib/calc.ts computePenaltyAccrual (pure fn)
--
-- 🔴 บั๊กที่ 1 (draft รอบแรก, ยังไม่ apply) — ครีมจับได้ก่อน deploy:
--   ตัดสินใจ "settled" ด้วย penalty_paid_for_installment(id) >= owed-ณ-วันนี้ (least(current_date-due_date,
--   max_days)*per_day) ซึ่งเทียบกับ owed ที่โตขึ้นทุกวัน (ไม่ใช่ owed ณ วันที่จ่ายจริง) ผลคือ "settled" ไม่ sticky
--   — ลูกค้าที่จ่ายค่าปรับครบไปแล้วเมื่อหลายวันก่อน (เช่น ทัน 4 วัน/400 ตอนจ่าย) พอวันเดินไปอีก owed-today โต
--   เกิน 400 → กลับมา "ไม่ settled" อีก แล้วโดนคิดเพิ่มขึ้นเรื่อยๆ จนถึงเพดาน 700 — diagnostic (read-only) ยืนยัน
--   244 งวด / 238 สัญญา จะโดนคิดเกินรวม 95,200 บาทถ้า deploy เวอร์ชันนั้น — ไม่ใช่แค่ไม่ตรงสเปก แต่เป็นบั๊กเงินจริง
--   ทางแก้: "settled" ต้อง sticky ที่วันที่ event จ่ายเกิดขึ้น (freeze ณ วันนั้นถาวร) ไม่ใช่เทียบกับ today ทุกครั้ง
--   ต้อง walk payment_log ทีละ event จริง (เหมือน computePenaltyAccrual ฝั่ง TS) ไม่มีทางลัด — เขียน helper ใหม่
--   public.penalty_accrual_for_installment(uuid) แทนการเทียบ penalty_paid_for_installment (mig 0115, เป็นแค่
--   "ผลรวมสะสม" ไม่รู้ "จ่ายทันวันไหน") ตรงๆ
--
-- 🔴 บั๊กที่ 2 (draft รอบสอง — เวอร์ชัน helper แรก, ยังไม่ apply) — ครีมจับได้ก่อน deploy อีกครั้ง:
--   helper ตัวแรกไม่เช็ค installments.paid_at เลย — งวดที่ลูกค้าจ่ายเงินต้น "ตรงเวลาหรือก่อนกำหนด" (paid_at::date
--   <= due_date) ที่ due_date อยู่ในอดีต + ไม่เคยมี payment_log ค่าปรับเลย (ไม่แปลก เพราะไม่เคยค้างจ่ายค่าปรับ)
--   จะ loop ไม่เจอ event ไหนเลย → ตกไป fallback "owed-ณ-วันนี้, settled=false" = คิดค่าปรับสูงสุดถึง 700 ทั้งที่
--   ลูกค้าจ่ายตรงเวลา! diagnostic ยืนยัน 1,510 สัญญา (งวดเก่าสุดจ่ายตรงเวลา) จะโดนคิดเกินรวม +1,047,300 บาท
--   ทางแก้: เพิ่ม guard ต้นฟังก์ชัน — ถ้า paid_at not null และ paid_at::date <= due_date (จ่ายตรงเวลา/ก่อนกำหนด)
--   → คืนค่าปรับ 0/settled=true ทันที ไม่ต้อง walk payment_log เลย (ไม่มีอะไรให้ walk อยู่แล้วในเคสนี้ตามนิยาม)
--
-- ทางแก้ (เวอร์ชันแก้บั๊กทั้งสอง):
--   1) helper ใหม่ public.penalty_accrual_for_installment(p_installment_id uuid) returns table(penalty_days
--      int, penalty_amount numeric, settled boolean) — mirror computePenaltyAccrual เป๊ะ:
--      0) guard แรกสุด (แก้บั๊กที่ 2): paid_at not null AND paid_at::date <= due_date (จ่ายเงินต้นตรงเวลา/ก่อน
--         กำหนด) → คืน (0, 0, true) ทันที ไม่ walk payment_log เลย
--      i) ไม่งั้น walk payment_log ('pay'/'cancel') ตาม created_at asc, cancel reset cumPaid+settled กลับเป็น
--         false (เผื่อโดนยกเลิกทีหลัง), event 'pay' แรกที่ cumPaid (สะสมหลัง cancel ล่าสุด) >= owed ณ "วันที่
--         event นั้นเกิด" (คลิป max_days) = settle → freeze penalty_days/penalty_amount ที่ค่า ณ วันนั้นถาวร
--         (แก้บั๊กที่ 1 — sticky ไม่เทียบ today ซ้ำ); ไม่มี event ไหนตามทันเลย → คืนค่า owed-ณ-วันนี้ settled=false
--   2) run_daily_update() — เรียก helper ครั้งเดียวต่องวด (cache ใน temp table กันเรียกซ้ำ) สำหรับทุกงวดค้าง
--      (late by due_date) ของสัญญา active ที่ไม่ overridden แล้วแยก 3 ผล:
--        a) settled=true แต่ penalty_days/penalty_amount ปัจจุบันใน installments ไม่ตรง frozen value (เช่น
--           ค้างมาจากบั๊ก owed-today เดิม หรือยังไม่เคย sync) → SET ให้ตรง "ครั้งเดียว" ที่ frozen value ห้าม
--           แตะอีกในรอบถัดๆ ไป (ตราบใดที่ยัง settled — helper คำนวณค่าเดิมซ้ำทุกวันก็ยังได้ผลเท่ากัน เพราะ
--           frozen ที่วันเดียวกันเสมอ)
--        b) settled=false และไม่ใช่งวดเก่าสุด (ตาม due_date) ในกลุ่ม "settled=false" ของสัญญานั้น → zero
--           (เหมือน 0031 เดิม แต่เทียบเฉพาะกับงวดอื่นที่ยัง unsettled เหมือนกัน — งวด settled ไม่นับเป็น
--           "คู่แข่ง earliest" อีกต่อไปเพราะ freeze แล้ว)
--        c) settled=false และเป็นงวดเก่าสุดในกลุ่ม unsettled ของสัญญานั้น → SET penalty_days/penalty_amount =
--           owed-ณ-วันนี้ (helper คืนค่านี้มาให้แล้วในกรณี settled=false)
--   3) block 1a (สถานะ late) และ block 2/3/4 (แจ้งเตือน + current_grade) ไม่แตะ — verbatim จาก 0018/0031
--   4) ข้าม penalty_overridden=true เสมอ + scope active contracts เท่านั้น (เหมือนเดิม) — ห้ามแตะ closed/returned
--
-- Freeze legacy กลุ่ม A (ก่อน function ใหม่มีผล):
--   54 เคสที่เงินต้นจ่ายช้าไปแล้ว (paid_at > due_date) แต่ไม่เคยจ่ายค่าปรับเลย (penalty_paid_for_installment=0)
--   จากบั๊กเดิมที่ freeze ค่าปรับไว้ตอนเงินต้นปิด — ถ้าไม่ freeze ก่อน ฟังก์ชันใหม่จะเห็นว่า "late by due_date +
--   not settled" ทันที แล้วคิดค่าปรับย้อนหลังพรวดเดียวเป็น 700 (เพดาน) ตั้งแต่วันแรกที่ deploy — ไม่ตรงข้อเท็จจริง
--   (ลูกค้ากลุ่มนี้จ่ายช้าแค่ไม่กี่วัน ไม่ควรโดน 700 ทันที) — set penalty_overridden=true ชั่วคราว (freeze ค่าเดิม
--   ที่มีอยู่ไว้ ไม่แตะ) รอเทียบ PJ รายเคสเป็นงานแยกทีหลัง (จะ update เป็นเลข PJ จริงตอนนั้น ไม่ใช่งานนี้)
--
--   🔴 (แก้รอบ 3) filter เดิมบังคับทั้ง `penalty_paid_for_installment(id)=0 AND penalty_amount=0` คู่กัน — ได้
--   แค่ 7 แถว เพราะกลุ่ม A จริงบางงวด penalty_amount > 0 อยู่แล้ว (จากกติกาเก่าที่เคยคำนวณไว้ก่อนเงินต้นปิด) แต่
--   ไม่เคยมี "การจ่าย" ค่าปรับจริงเลย (pen_paid=0) — เงื่อนไขนี้คือตัวกำหนดกลุ่ม A ที่แท้จริง (ไม่ใช่ penalty_amount
--   ปัจจุบัน) จึงตัด `penalty_amount=0` ออก เหลือแค่ `penalty_paid_for_installment(id)=0` → ครบ 54 แถวตามที่ยืนยัน
--
--   ⚠️ ห้าม freeze กลุ่ม B/C (เคสที่มี penalty_paid_for_installment > 0 แบบวิไลรัตน์/สุภัสรา ฯลฯ — พวกนั้นมี
--   ประวัติจ่ายค่าปรับมาแล้วบางส่วน ต้องปล่อยให้กติกาใหม่คำนวณ/auto-settle เอง ไม่ใช่ freeze) — เงื่อนไข
--   `penalty_paid_for_installment(id) = 0` กันกลุ่มนี้ออกอยู่แล้ว (ไม่ต้องพึ่ง penalty_amount=0 ช่วยกรองอีก)
--
-- Additive only — create or replace function, สร้าง backup table ก่อน update, ไม่ drop ข้อมูลใดๆ
-- ============================================================================


-- ============================================================================
-- SECTION 1: Backup ก่อน freeze กลุ่ม A (safety net สำหรับ rollback ย้อนหลัง)
-- ============================================================================

create table if not exists public._fix_penaccrual_freezeA_0718_bk as
select i.id, i.contract_id, i.installment_no, i.due_date, i.paid_at,
       i.penalty_amount, i.penalty_days, i.penalty_overridden
from public.installments i
join public.contracts c on c.id = i.contract_id
where c.status = 'active'
  and coalesce(i.penalty_overridden, false) = false
  and i.paid_at is not null
  and i.paid_at::date > i.due_date
  and i.due_date < current_date
  and public.penalty_paid_for_installment(i.id) = 0;
  -- (แก้รอบ 3) เอา `and coalesce(i.penalty_amount, 0) = 0` ออก — ตัดสินกลุ่ม A ด้วย "ไม่เคยจ่ายค่าปรับ"
  -- (pen_paid=0) เท่านั้น ไม่ใช่ penalty_amount ปัจจุบัน — แก้ 7 → 54 แถว

-- ============================================================================
-- SECTION 2: helper — public.penalty_accrual_for_installment(uuid)
--   mirror src/lib/calc.ts computePenaltyAccrual เป๊ะ (walk event ทีละจุด, settled sticky ที่วัน event จริง)
-- ============================================================================

create or replace function public.penalty_accrual_for_installment(p_installment_id uuid)
returns table(penalty_days int, penalty_amount numeric, settled boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_due_date       date;
  v_paid_at        timestamptz;
  v_per_day        numeric := (select value::numeric from app_settings where key = 'penalty_per_day');
  v_max_days       int     := (select value::int    from app_settings where key = 'penalty_max_days');
  v_cum_paid       numeric := 0;
  v_settled        boolean := false;
  v_settled_days   int     := 0;
  v_settled_amount numeric := 0;
  v_owed_days      int;
  v_owed_amount    numeric;
  rec              record;
begin
  select due_date, paid_at into v_due_date, v_paid_at from public.installments where id = p_installment_id;

  -- (แก้รอบ 3 — บั๊กที่ 2) เงินต้นจ่ายตรงเวลาหรือก่อนกำหนด (paid_at::date <= due_date) → ไม่เคยมีค่าปรับค้างจริง
  -- เลยตามนิยาม ไม่ต้อง walk payment_log เลย (ไม่มีอะไรให้ walk อยู่แล้ว) คืน 0/settled=true ทันที กันไม่ให้ตกไป
  -- fallback "owed-ณ-วันนี้, settled=false" ที่ท้ายฟังก์ชัน ซึ่งจะคิดค่าปรับสูงสุดถึง 700 ทั้งที่จ่ายตรงเวลา
  if v_paid_at is not null and v_paid_at::date <= v_due_date then
    return query select 0, 0::numeric, true;
    return;
  end if;

  -- walk เฉพาะ 'pay'/'cancel' เรียง created_at asc — 'edit' ไม่มีผล (0-contribution) จึงข้ามได้เลย
  -- เหมือน penaltyPaidForInstallment/computePenaltyAccrual ฝั่ง TS (ผลลัพธ์เท่ากัน ไม่ต้อง fetch แถวเก็บไว้)
  for rec in
    select action, coalesce(penalty_paid_amount, 0) as pen_paid, created_at
      from public.payment_log
     where installment_id = p_installment_id
       and action in ('pay', 'cancel')
     order by created_at asc
  loop
    if rec.action = 'cancel' then
      -- ยกเลิก → reset สะสม และถอนสถานะ settled ที่เคย freeze ไว้ก่อนหน้า (การจ่ายที่ทำให้ settle ถูกยกเลิกแล้ว
      -- ต้องกลับไปนับต่อ ไม่ใช่ค้างแช่แข็งผิดๆ)
      v_cum_paid       := 0;
      v_settled        := false;
      v_settled_days   := 0;
      v_settled_amount := 0;
      continue;
    end if;

    -- action = 'pay'
    v_cum_paid := v_cum_paid + rec.pen_paid;
    if not v_settled then
      v_owed_days   := least(greatest(0, (rec.created_at::date - v_due_date)::int), v_max_days);
      v_owed_amount := v_owed_days * v_per_day;
      if v_owed_amount > 0 and v_cum_paid >= v_owed_amount then
        -- event แรกที่จ่ายทันยอดค้างจริง ณ วันนั้น → settle → freeze ถาวร (sticky ที่วัน event นี้ ไม่ใช่ today)
        v_settled        := true;
        v_settled_days   := v_owed_days;
        v_settled_amount := v_owed_amount;
      end if;
    end if;
  end loop;

  if v_settled then
    return query select v_settled_days, v_settled_amount, true;
    return;
  end if;

  v_owed_days   := least(greatest(0, (current_date - v_due_date)::int), v_max_days);
  v_owed_amount := v_owed_days * v_per_day;
  return query select v_owed_days, v_owed_amount, false;
end;
$$;

grant execute on function public.penalty_accrual_for_installment(uuid)
  to authenticated, service_role;

comment on function public.penalty_accrual_for_installment(uuid) is
  '(0116) ค่าปรับค้าง+สถานะ settled ของ 1 งวด — mirror src/lib/calc.ts computePenaltyAccrual: guard แรกสุด เงินต้นจ่ายตรงเวลา/ก่อนกำหนด (paid_at::date<=due_date) → คืน 0/settled=true ทันที (แก้บั๊กที่ 2 — ก่อนแก้ 1,510 สัญญาจะโดนคิดเกิน +1,047,300 บาท เพราะตกไป fallback owed-today ทั้งที่จ่ายตรงเวลา); ไม่งั้น walk payment_log pay/cancel ตาม created_at asc, cancel รีเซ็ต cumPaid+settled, event pay แรกที่จ่ายทัน owed-ณ-วันนั้น = settle freeze ถาวร (sticky ที่วัน event ไม่ใช่ today — แก้บั๊กที่ 1); ไม่ settled → คืน owed-ณ-วันนี้ คลิป max_days; ใช้แทนการเทียบ penalty_paid_for_installment(mig 0115) ตรงๆ กับ owed-today ซึ่งไม่ sticky';


-- ============================================================================
-- SECTION 3: run_daily_update() — ใช้ helper ใหม่แทนสูตร owed-today ตรงๆ
-- ============================================================================

create or replace function public.run_daily_update()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- (0116) per_day/max_days ไม่ต้องประกาศตรงนี้อีกแล้ว — penalty_accrual_for_installment (SECTION 2) อ่าน
  -- app_settings เองภายใน ครอบทั้ง owed-at-event-date และ owed-today ให้แล้ว

  -- 1a) ตั้ง status='late' สำหรับงวดที่ยังไม่จ่ายเงินต้นและเลยกำหนด (verbatim จาก 0031 — ไม่แตะ)
  update public.installments i
  set status = 'late'
  from public.contracts c
  where i.contract_id = c.id
    and c.status = 'active'
    and i.paid_at is null
    and i.due_date < current_date;

  -- 1b) (0116) คำนวณ accrual ของทุกงวดค้าง (late by due_date) สัญญา active ที่ไม่ overridden ครั้งเดียว
  --     ผ่าน helper penalty_accrual_for_installment (walk payment_log จริง) เก็บใน temp table กันเรียกซ้ำ
  --     หลายรอบต่องวดในบล็อกถัดไป — temp table หมดอายุอัตโนมัติที่ commit (on commit drop)
  create temporary table if not exists pg_temp.penalty_accrual_today (
    installment_id uuid primary key,
    contract_id    uuid,
    due_date       date,
    penalty_days   int,
    penalty_amount numeric,
    settled        boolean
  ) on commit drop;
  truncate pg_temp.penalty_accrual_today;

  insert into pg_temp.penalty_accrual_today
    (installment_id, contract_id, due_date, penalty_days, penalty_amount, settled)
  select i.id, i.contract_id, i.due_date, pa.penalty_days, pa.penalty_amount, pa.settled
  from public.installments i
  join public.contracts c on c.id = i.contract_id
  cross join lateral public.penalty_accrual_for_installment(i.id) pa
  where c.status = 'active'
    and i.due_date < current_date
    and coalesce(i.penalty_overridden, false) = false;

  -- 1c) reconcile งวด settled: ถ้า penalty_days/penalty_amount ปัจจุบันไม่ตรง frozen value ที่ helper คำนวณได้
  --     (เช่น ค้างมาจากบั๊ก owed-today เดิมที่โตทุกวัน หรือยังไม่เคย sync มาก่อน) → SET ให้ตรง "ครั้งเดียว" ที่
  --     ค่า frozen ณ วันจ่าย ไม่ใช่โตตาม today อีกต่อไป — งวด settled จะไม่ถูกแตะโดย block 1d/1e เลย (ยกเว้น
  --     รอบถัดไปมี event cancel เกิดขึ้น helper จะคืน settled=false เอง แล้วไหลไป 1d/1e ตามปกติ)
  update public.installments i
  set penalty_days   = pat.penalty_days,
      penalty_amount = pat.penalty_amount
  from pg_temp.penalty_accrual_today pat
  where i.id = pat.installment_id
    and pat.settled = true
    and (i.penalty_days is distinct from pat.penalty_days
         or i.penalty_amount is distinct from pat.penalty_amount);

  -- 1d) reset เป็น 0 สำหรับงวดค้างที่ "ยังไม่ settled" แต่ไม่ใช่งวดเก่าสุด (ตาม due_date) ในกลุ่ม unsettled
  --     ของสัญญานั้น — เทียบเฉพาะกับงวดอื่นที่ unsettled เหมือนกัน (งวด settled ถือว่า freeze แล้ว ไม่นับเป็น
  --     "คู่แข่ง earliest" อีกต่อไป — ต่างจาก 0031 เดิมที่เทียบกับ paid_at is null ตรงๆ)
  update public.installments i
  set penalty_amount = 0,
      penalty_days   = 0
  from pg_temp.penalty_accrual_today pat
  where i.id = pat.installment_id
    and pat.settled = false
    and exists (
      select 1
      from pg_temp.penalty_accrual_today earlier
      where earlier.contract_id = pat.contract_id
        and earlier.settled = false
        and earlier.due_date < pat.due_date
    );

  -- 1e) คิดค่าปรับสำหรับงวดค้างเก่าสุดที่ยัง eligible (unsettled) ของสัญญานั้น = owed-ณ-วันนี้ (helper คืนค่านี้
  --     มาให้แล้วในกรณี settled=false — เพดาน max_days อยู่ในตัว)
  update public.installments i
  set penalty_days   = pat.penalty_days,
      penalty_amount = pat.penalty_amount
  from pg_temp.penalty_accrual_today pat
  where i.id = pat.installment_id
    and pat.settled = false
    and not exists (
      select 1
      from pg_temp.penalty_accrual_today earlier
      where earlier.contract_id = pat.contract_id
        and earlier.settled = false
        and earlier.due_date < pat.due_date
    );

  -- 2) แจ้งเตือน: ครบกำหนดชำระวันนี้ (กันซ้ำในวันเดียว) — verbatim จาก 0018/0031, ไม่แตะ
  insert into public.notifications (contract_id, type, message)
  select i.contract_id, 'due_today', 'ครบกำหนดชำระวันนี้'
  from public.installments i
  join public.contracts c on c.id = i.contract_id
  where c.status = 'active'
    and i.paid_at is null
    and i.due_date = current_date
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = i.contract_id
        and n.type = 'due_today'
        and n.created_at::date = current_date
    );

  -- 3) แจ้งเตือน: เพิ่งเลยกำหนด (เลยมา 1 วัน) — verbatim จาก 0018/0031, ไม่แตะ
  insert into public.notifications (contract_id, type, message)
  select i.contract_id, 'newly_late', 'เลยกำหนดชำระแล้ว'
  from public.installments i
  join public.contracts c on c.id = i.contract_id
  where c.status = 'active'
    and i.paid_at is null
    and i.due_date = current_date - 1
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = i.contract_id
        and n.type = 'newly_late'
        and n.created_at::date = current_date
    );

  -- 4) [0018] อัปเดต current_grade ในสัญญา active — verbatim จาก 0018/0031, ไม่แตะ
  update public.contracts c
  set current_grade = grade_for_days_late(
    greatest(
      0,
      (current_date - (
        select min(i.due_date)
        from public.installments i
        where i.contract_id = c.id and i.paid_at is null
      ))::int
    )
  )
  where c.status = 'active';

end;
$$;

comment on function public.run_daily_update() is
  'cron รายวัน: ตั้ง status=late, คิด/reset ค่าปรับ (0116-v2: ใช้ helper penalty_accrual_for_installment แทน owed-today ตรงๆ — settled sticky ที่วันจ่ายจริง ไม่ใช่เทียบ today ทุกวัน, eligible=late by due_date AND NOT settled, งวด settled reconcile ครั้งเดียวแล้ว freeze), แจ้งเตือน due_today/newly_late, อัปเดต current_grade';


-- ============================================================================
-- SECTION 4: Freeze กลุ่ม A (54 เคส legacy) — ต้องทำก่อนฟังก์ชันใหม่ตัวถัดไปรัน ไม่งั้นเด้ง 700 ทันที
--   idempotent: join กับ backup table (SECTION 1) ตรง id เท่านั้น + guard penalty_overridden ปัจจุบัน
--   ยังเป็น false เท่านั้น (กันเผลอรัน migration ซ้ำแล้วไปกระทบแถวที่ admin override เพิ่มเองทีหลัง)
-- ============================================================================

update public.installments i
set penalty_overridden = true
from public._fix_penaccrual_freezeA_0718_bk bk
where i.id = bk.id
  and coalesce(i.penalty_overridden, false) = false;

comment on table public._fix_penaccrual_freezeA_0718_bk is
  '(0116) snapshot ก่อน freeze 54 เคส legacy กลุ่ม A (เงินต้นจ่ายช้าจากบั๊กเดิม ไม่เคยมีค่าปรับ) → penalty_overridden=true ชั่วคราว รอเทียบ PJ รายเคสเป็นงานแยก';


-- ============================================================================
-- SECTION 5: Smoke SQL (ครีมรันผ่าน MCP หลัง apply — begin/rollback เท่านั้น ห้าม commit ตอนทดสอบ)
-- ============================================================================

-- 5a) backup table มีแถว ~54 (ยืนยันตัวเลขก่อน apply จริง):
--   select count(*) from public._fix_penaccrual_freezeA_0718_bk;
--   -- expected: ~54

-- 5b) sanity: ไม่มีแถวไหนใน backup ที่ penalty_paid_for_installment > 0 (กันเผลอ freeze กลุ่ม B):
--   select count(*) from public._fix_penaccrual_freezeA_0718_bk bk
--     where public.penalty_paid_for_installment(bk.id) > 0;
--   -- expected: 0

-- 5c) sanity helper เดี่ยว: เทียบ penalty_accrual_for_installment กับเคส trace ที่รู้คำตอบ (ถ้ามีเคสจริงตรง
--     Trace 1 ของ calc.ts computePenaltyAccrual — จ่ายทัน 4 วัน/400):
--   select * from public.penalty_accrual_for_installment('<installment_id>'::uuid);
--   -- expected: (penalty_days, penalty_amount, settled) ตรงกับที่คำนวณมือ/ตรง TS trace

-- 5c-2) 🔴 sanity helper — guard จ่ายตรงเวลา (บั๊กที่ 2): หางวดที่ paid_at::date <= due_date, due_date<today,
--     ไม่เคยมี payment_log ค่าปรับเลย → helper ต้องคืน (0, 0, true) ไม่ใช่ owed-today:
--   select i.id, i.due_date, i.paid_at, pa.penalty_days, pa.penalty_amount, pa.settled
--     from public.installments i
--     cross join lateral public.penalty_accrual_for_installment(i.id) pa
--    where i.paid_at is not null and i.paid_at::date <= i.due_date and i.due_date < current_date
--    limit 5;
--   -- expected: penalty_days=0, penalty_amount=0, settled=true ทุกแถว

-- 5d) TEST (ก): งวด late ปกติ (unpaid, not overridden, ไม่เคยจ่ายค่าปรับเลย) ยังได้ค่าปรับถูกต้องเหมือนเดิม —
--     regression, หา contract ที่มีงวดค้างธรรมดา 1 งวด:
--   begin;
--     select id, installment_no, due_date, paid_at, penalty_amount, penalty_days, penalty_overridden
--       from public.installments where contract_id = '<contract_id_normal_late>' order by installment_no;
--     select run_daily_update();
--     select id, installment_no, penalty_amount, penalty_days
--       from public.installments where contract_id = '<contract_id_normal_late>' order by installment_no;
--     -- expected: งวดค้างเก่าสุดได้ least(days,7)*100 เหมือนพฤติกรรมเดิม (ไม่เปลี่ยนพฤติกรรม regression)
--   rollback;

-- 5e) TEST (ข): เคสกลุ่ม B non-overridden ที่ยังไม่ทัน owed-today (ตัวอย่าง — วิไลรัตน์ตัวจริง overridden แล้ว
--     ใช้เคสอื่นในกลุ่มเดียวกันแทนถ้ามี — ถ้าไม่มีให้จำลอง insert payment_log ใน transaction นี้แล้ว rollback ทิ้ง):
--   begin;
--     select i.id, i.contract_id, i.installment_no, i.due_date, i.penalty_amount,
--            pa.penalty_days, pa.penalty_amount as helper_amount, pa.settled
--       from public.installments i join public.contracts c on c.id=i.contract_id
--       cross join lateral public.penalty_accrual_for_installment(i.id) pa
--      where c.status='active' and coalesce(i.penalty_overridden,false)=false
--        and i.due_date < current_date and pa.settled = false
--        and exists (select 1 from public.payment_log pl where pl.installment_id=i.id and pl.action='pay'
--                     and coalesce(pl.penalty_paid_amount,0) > 0)
--      limit 5;
--     select run_daily_update();
--     -- expected: งวดที่เจอด้านบน (ถ้าเป็นงวดเก่าสุด unsettled ของสัญญานั้น) ได้ penalty_amount = helper_amount
--     --           (นับต่อจาก owed-today ไม่ freeze ผิดที่)
--   rollback;

-- 5f) TEST (ค): 54 เคสกลุ่ม A ถูก freeze overridden=true จริง (นับหลัง SECTION 4 — เขียนจริงแล้ว ไม่ใช่
--     begin/rollback แยก แต่ตรวจนับได้จาก backup join ปัจจุบัน):
--   select count(*) from public._fix_penaccrual_freezeA_0718_bk bk
--     join public.installments i on i.id = bk.id
--    where i.penalty_overridden = true;
--   -- expected: เท่ากับ count ใน 5a (ทุกแถวถูก flip แล้ว)

-- 5g) TEST (ง): งวดที่ settled แล้ว (helper settled=true) ไม่ถูก zero ทับ และถูก reconcile ให้ตรง frozen value
--     ครั้งเดียว (ถ้าค่าปัจจุบันเพี้ยนจากบั๊ก owed-today เดิม):
--   begin;
--     select i.id, i.penalty_amount as before_amount, pa.penalty_amount as frozen_amount, pa.settled
--       from public.installments i join public.contracts c on c.id=i.contract_id
--       cross join lateral public.penalty_accrual_for_installment(i.id) pa
--      where c.status='active' and coalesce(i.penalty_overridden,false)=false
--        and i.due_date < current_date and pa.settled = true
--      limit 5;
--     select run_daily_update();
--     select i.id, i.penalty_amount as after_amount
--       from public.installments i where i.id in (<ids จาก select ก่อนหน้า>);
--     -- expected: after_amount = frozen_amount เสมอ (reconcile ครั้งเดียว ไม่ใช่ before_amount เดิมถ้าเพี้ยน)
--     -- รันซ้ำ run_daily_update() อีกรอบในทรานแซกชันเดียวกัน → after_amount ต้องไม่เปลี่ยนอีก (sticky จริง)
--     select run_daily_update();
--     select i.id, i.penalty_amount from public.installments i where i.id in (<ids เดิม>);
--     -- expected: เท่าเดิมทุกแถว (proof ว่า sticky ไม่โตตาม today แม้รันซ้ำ)
--   rollback;

-- 5h) 🔴 CRITICAL — diagnostic ของครีมที่จับบั๊กที่ 1 ได้ (sticky) ต้องได้ 0 rows / over_charge เป็น null หลังแก้:
--   begin;
--     select run_daily_update();
--     with pen_pay as (
--       select installment_id, max(created_at::date) last_pen_pay_date, sum(penalty_paid_amount) pen_paid
--       from payment_log where action='pay' and coalesce(penalty_paid_amount,0)>0 group by installment_id)
--     select count(*), sum(least(current_date-i.due_date,7)*100 - pp.pen_paid) over_charge
--     from installments i join contracts c on c.id=i.contract_id join pen_pay pp on pp.installment_id=i.id
--     where c.status='active' and coalesce(i.penalty_overridden,false)=false and i.due_date<current_date
--       and pp.pen_paid >= least(pp.last_pen_pay_date-i.due_date,7)*100
--       and i.penalty_amount > pp.pen_paid;
--     -- expected: count=0 (over_charge=null) — ก่อนแก้เคยได้ 244 งวด / 95,200 บาท
--     -- ⚠️ ยกเว้นเคสรู้อยู่แล้ว 1 เคส: ชนันกานต์ INV-1778593101 ง2 = ค่าปรับผีติดผิดงวดจากข้อมูลเก่า
--     --   (ไม่เกี่ยวกับกติกา 0116 — เป็นงานแยกเทียบ PJ รายเคส) ถ้าเจอแถวนี้โผล่เดี่ยวๆ ถือว่าผ่าน
--   rollback;

-- 5h-2) 🔴 CRITICAL — diagnostic บั๊กที่ 2 (จ่ายตรงเวลาแต่โดนคิดค่าปรับ) ต้องได้ 0 rows หลังแก้:
--   begin;
--     select run_daily_update();
--     select count(*), sum(i.penalty_amount) as over_charge
--       from public.installments i join public.contracts c on c.id = i.contract_id
--      where c.status = 'active' and coalesce(i.penalty_overridden, false) = false
--        and i.due_date < current_date and i.penalty_amount > 0
--        and i.paid_at is not null and i.paid_at::date <= i.due_date;
--     -- expected: count=0 (over_charge=null) — ก่อนแก้เคยได้ 1,510 สัญญา / +1,047,300 บาท
--   rollback;

-- 5h-3) รันซ้ำ run_daily_update() 2 รอบในทรานแซกชันเดียวกัน แล้วเทียบ penalty_amount ทั้งตาราง (ของ active,
--     not overridden, due_date<today) ต้องไม่ขยับเลย (proof sticky ระดับ portfolio ไม่ใช่แค่ 5 แถวตัวอย่างใน 5g):
--   begin;
--     select run_daily_update();
--     create temp table _t1 as select id, penalty_amount, penalty_days from installments
--       where status='late' and coalesce(penalty_overridden,false)=false;
--     select run_daily_update();
--     select count(*) from _t1 t1 join installments i on i.id = t1.id
--       where i.penalty_amount is distinct from t1.penalty_amount
--          or i.penalty_days is distinct from t1.penalty_days;
--     -- expected: 0 (ไม่มีแถวไหนขยับระหว่าง 2 รอบ)
--   rollback;

-- 5i) sanity: ยังไม่มี contract ไหนมีมากกว่า 1 งวด "unsettled" ที่ penalty_amount>0 พร้อมกัน (งวด settled ที่
--     freeze ค่าไว้หลายงวดพร้อมกันในสัญญาเดียวถือเป็นเรื่องปกติ ไม่นับเป็นบั๊ก):
--   select i.contract_id, count(*) as active_unsettled_pen_count
--   from public.installments i join public.contracts c on c.id = i.contract_id
--   cross join lateral public.penalty_accrual_for_installment(i.id) pa
--   where c.status = 'active' and coalesce(i.penalty_overridden,false) = false
--     and i.due_date < current_date and pa.settled = false and i.penalty_amount > 0
--   group by i.contract_id
--   having count(*) > 1;
--   -- expected: 0 rows
