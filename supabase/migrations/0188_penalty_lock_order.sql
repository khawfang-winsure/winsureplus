-- 0188: งานแก้ค่าปรับ + งาน cron รายวัน ล็อกสัญญาก่อนงวดเหมือนทางลงเงิน (0185) กัน deadlock ล็อกวนกัน
--
-- ปัญหา: 0185 ทำให้ทางลงเงิน 6 ตัวล็อก contracts -> installments แต่ฝั่งค่าปรับยังล็อกสวน
--   admin_set_installment_penalty (0096) / staff_set_installment_penalty (0127) / pj_review_set_penalty (0117, รุ่น 0186)
--   ล็อกแถวงวดก่อน แล้ว trigger track_extension_activity (0171) ค่อยไปล็อกสัญญาตอนเขียน = คนละทางกับ record_payment_spread
--   run_daily_update (cron) แก้งวดทั้งก้อน (ข้อ 1a-1e) แล้วค่อยแก้ contracts (ข้อ 4) ใน tx เดียว = ล็อกงวดก่อนสัญญาเช่นกัน
--   Postgres จะตัดทิ้งฝั่งใดฝั่งหนึ่ง (เงินไม่เพี้ยน) แต่ถ้า cron เป็นฝ่ายแพ้ ค่าปรับทั้งคืน rollback และไม่มีใคร retry
--
-- แก้ 1: ฟังก์ชันรายงวด 3 ตัว เพิ่มบล็อกล็อกสัญญาแบบ 0185 (อ่าน contract_id แบบไม่ล็อก -> perform 1 from contracts ... for update -> เนื้อเดิม)
--   เนื้อเดิมคัดจาก: admin_set = 0096 (ไม่มีไฟล์ไหนแก้ต่อ), staff_set = 0127 (ไม่มีไฟล์ไหนแก้ต่อ), pj_review_set_penalty = 0186 (รุ่นที่มีเช็คสิทธิ์)
--   signature / security definer / search_path / เช็คสิทธิ์ / grant เดิมครบ (create or replace คง ACL เดิม)
-- แก้ 2: run_daily_update แยกเป็น 2 ชั้น
--   * run_daily_update_body() = เนื้อรุ่นที่อยู่บน prod ตอน apply "ไม่แก้สักตัวอักษร" (คัดด้วย pg_get_functiondef แล้วเปลี่ยนแค่ชื่อ)
--     ผลคำนวณจึงเหมือนเดิมทุกบรรทัดโดยโครงสร้าง; มี guard ว่าเป็นรุ่น 0116 จริง ไม่งั้นยกเลิกทั้ง migration
--   * run_daily_update() = ตัวห่อ: ล็อกสัญญา active ทั้งหมดเรียงตาม id ก่อน (สัญญา -> งวด ตรงกับทางลงเงิน) แล้วเรียก body
--     ถ้าโดน deadlock (40P01) retry ได้อีก 2 รอบ (subtransaction; รอ 2/4 วินาที) ครบแล้วค่อย raise
--   cron เรียก run_daily_update() เหมือนเดิม (ไม่ต้องแก้ cron job); ACL เดิม (service_role เท่านั้น จาก 0186)
-- ข้อควรรู้: cron ถือล็อกสัญญา active ตลอดเวลาที่รัน (การลงเงิน/แก้สัญญาบนสัญญาเหล่านั้นรอจน cron จบ) -- ดูเวลารันจริงใน cron.job_run_details ก่อนขึ้นระบบ
--   cron ตั้ง 00:05 UTC = 07:05 น. ไทย ตรงรอบ pj-sync (ทุก 15 นาที)
-- ไม่ใส่ lock_timeout (เหตุผลเดียวกับ 0185); ไม่เปลี่ยนตาราง/ข้อมูล
-- ขึ้นระบบ: apply migration นี้อย่างเดียว ไม่ต้อง deploy เว็บ/pj-sync

-- ===== admin_set_installment_penalty: เนื้อจาก 0096 + บล็อกล็อกสัญญา =====
create or replace function public.admin_set_installment_penalty(
  p_installment_id uuid,
  p_penalty_amount  numeric,
  p_reason          text
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_installment   installments%rowtype;
  v_old_amount    numeric;
  v_by_name       text;
  v_contract_id   uuid;
begin
  -- SECURITY GUARD: admin เท่านั้น (staff/freelancer เรียกไม่ผ่าน)
  if not is_admin() then
    raise exception 'permission denied: admin_set_installment_penalty requires admin role';
  end if;

  if p_penalty_amount is null or p_penalty_amount < 0 then
    raise exception 'ค่าปรับต้องไม่ติดลบ: %', p_penalty_amount;
  end if;

  if p_penalty_amount > 5000 then
    raise exception 'ค่าปรับสูงผิดปกติ (> 5000 บาท) โปรดตรวจสอบก่อนบันทึก: %', p_penalty_amount;
  end if;

  -- (0188) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread (0185)
  select contract_id into v_contract_id from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_contract_id for update;
  end if;

  -- ล็อกแถวงวด + โหลดค่าเดิม
  select * into v_installment
    from public.installments
    where id = p_installment_id
    for update;

  if not found then
    raise exception 'ไม่พบงวดผ่อนนี้: %', p_installment_id;
  end if;

  v_old_amount := v_installment.penalty_amount;

  -- ชื่อผู้แก้ = จาก profiles ของผู้เรียก (ไม่รับจาก client กันปลอมชื่อ)
  select full_name into v_by_name from public.profiles where id = auth.uid();

  -- แก้ค่าปรับ + กัน cron ทับ
  update public.installments
     set penalty_amount    = p_penalty_amount,
         penalty_days      = round(p_penalty_amount / 100.0)::int,
         penalty_overridden = true
   where id = p_installment_id;

  -- audit trail
  insert into public.penalty_override_history (
    installment_id, contract_id, old_amount, new_amount, reason, by_name
  ) values (
    p_installment_id, v_installment.contract_id, v_old_amount, p_penalty_amount, p_reason, v_by_name
  );
end;
$$;

-- ===== staff_set_installment_penalty: เนื้อจาก 0127 + บล็อกล็อกสัญญา =====
create or replace function public.staff_set_installment_penalty(
  p_installment_id uuid,
  p_penalty_amount  numeric,
  p_reason          text
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_installment     installments%rowtype;
  v_contract_status text;
  v_role            text;
  v_old_amount      numeric;
  v_by_name         text;
  v_per_day         numeric;
  v_penalty_paid    numeric;
  v_contract_id     uuid;
begin
  -- SECURITY GUARD: ต้องเป็น admin หรือ staff เท่านั้น (freelancer/accounting/executive/ไม่มี profile เลย ผ่านไม่ได้)
  select role into v_role from public.profiles where id = auth.uid();

  if v_role is null or v_role not in ('admin', 'staff') then
    raise exception 'ไม่มีสิทธิ์แก้ค่าปรับ';
  end if;

  -- บังคับระบุเหตุผลเสมอ (ทั้ง admin และ staff) — audit ต้องอ่านรู้เรื่องว่าทำไมถึงแก้
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ต้องระบุเหตุผล';
  end if;

  if p_penalty_amount is null or p_penalty_amount < 0 then
    raise exception 'ค่าปรับต้องไม่ติดลบ: %', p_penalty_amount;
  end if;

  if p_penalty_amount > 5000 then
    raise exception 'ค่าปรับสูงผิดปกติ (เกิน 5000 บาท) โปรดตรวจสอบก่อนบันทึก: %', p_penalty_amount;
  end if;

  -- (0188) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread (0185)
  select contract_id into v_contract_id from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_contract_id for update;
  end if;

  -- ล็อกแถวงวด + โหลดค่าเดิม
  select * into v_installment
    from public.installments
   where id = p_installment_id
   for update;

  if not found then
    raise exception 'ไม่พบงวดผ่อนนี้: %', p_installment_id;
  end if;

  v_old_amount := v_installment.penalty_amount;

  select status into v_contract_status
    from public.contracts
   where id = v_installment.contract_id;

  -- ด่านเพิ่มเฉพาะ staff (admin ข้าม 3 ข้อนี้ทั้งหมด คงอำนาจเดิมของ 0096)
  if v_role = 'staff' then
    if v_contract_status is distinct from 'active' then
      raise exception 'แก้ค่าปรับได้เฉพาะสัญญาที่ยัง active';
    end if;

    if v_installment.paid_at is not null then
      raise exception 'งวดนี้ปิดแล้ว แก้ค่าปรับไม่ได้ทางนี้';
    end if;

    v_penalty_paid := public.penalty_paid_for_installment(p_installment_id);

    if p_penalty_amount < v_penalty_paid then
      raise exception 'ตั้งค่าปรับต่ำกว่ายอดที่เก็บไปแล้วไม่ได้ (เก็บแล้ว % บาท)', v_penalty_paid;
    end if;
  end if;

  -- อัตราค่าปรับ/วัน จาก app_settings (ตรงกับ 0116/0117 + DEFAULT_PENALTY_PER_DAY ฝั่ง calc.ts) — fallback 100
  select value::numeric into v_per_day
    from public.app_settings
   where key = 'penalty_per_day';

  if v_per_day is null or v_per_day <= 0 then
    v_per_day := 100;
  end if;

  -- ชื่อผู้แก้ = จาก profiles ของผู้เรียก (ไม่รับจาก client กันปลอมชื่อ)
  select full_name into v_by_name from public.profiles where id = auth.uid();

  -- แก้ค่าปรับ + กัน cron (run_daily_update/0116) ทับ
  update public.installments
     set penalty_amount     = p_penalty_amount,
         penalty_days       = round(p_penalty_amount / v_per_day)::int,
         penalty_overridden = true
   where id = p_installment_id;

  -- audit trail (schema เดิมของ 0036/0096 — ไม่ต้องเพิ่มคอลัมน์)
  insert into public.penalty_override_history (
    installment_id, contract_id, old_amount, new_amount, reason, by_name
  ) values (
    p_installment_id, v_installment.contract_id, v_old_amount, p_penalty_amount, p_reason, v_by_name
  );
end;
$$;

-- ===== pj_review_set_penalty: เนื้อจาก 0186 (รุ่นมีเช็คสิทธิ์) + บล็อกล็อกสัญญา =====
create or replace function public.pj_review_set_penalty(
  p_installment_id uuid,
  p_amount         numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_installment installments%rowtype;
  v_per_day     numeric;
  v_contract_id uuid;
begin
  -- (0186) สิทธิ์: ต้องเป็น admin หรือ staff ที่ active (เหมือน apply_pj_review_payment)
  -- auth.uid() ว่าง = service_role/postgres เท่านั้น (anon/PUBLIC ถูกถอน EXECUTE ในไฟล์นี้แล้ว)
  if auth.uid() is not null and not exists (
       select 1 from public.profiles
        where id = auth.uid() and role in ('admin', 'staff') and active = true) then
    raise exception 'FORBIDDEN: ต้องเป็น admin หรือ staff ที่ยัง active' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'ค่าปรับต้องไม่ติดลบ: %', p_amount;
  end if;

  -- (0188) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread (0185)
  select contract_id into v_contract_id from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_contract_id for update;
  end if;

  -- ล็อกแถวงวด
  select * into v_installment
    from public.installments
   where id = p_installment_id
   for update;

  if not found then
    raise exception 'ไม่พบงวดผ่อนนี้: %', p_installment_id;
  end if;

  select value::numeric into v_per_day
    from public.app_settings
   where key = 'penalty_per_day';

  if v_per_day is null or v_per_day <= 0 then
    v_per_day := 100; -- fallback กันหาร 0/null ถ้า app_settings ไม่มี key นี้ (ไม่ควรเกิดในทางปฏิบัติ)
  end if;

  update public.installments
     set penalty_amount     = p_amount,
         penalty_days       = round(p_amount / v_per_day)::int,
         penalty_overridden = true
   where id = p_installment_id;
end;
$$;

-- ===== run_daily_update: แยกเนื้อเดิม (ไม่แก้) เป็น run_daily_update_body แล้วห่อด้วยล็อกสัญญา + retry =====
do $mig$
declare
  v_def  text;
  v_have_body boolean;
  v_cur_is_wrapper boolean;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'run_daily_update' and p.pronargs = 0;
  if v_def is null then
    raise exception '0188: ไม่พบ public.run_daily_update()';
  end if;

  v_cur_is_wrapper := position('run_daily_update_body' in v_def) > 0;
  v_have_body := exists (select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'run_daily_update_body' and p.pronargs = 0);

  if v_cur_is_wrapper then
    -- รันซ้ำ: ตัวห่อมีอยู่แล้ว ต้องมี body ด้วย ไม่งั้นหยุด
    if not v_have_body then
      raise exception '0188: run_daily_update เป็นตัวห่อแล้วแต่ไม่พบ run_daily_update_body';
    end if;
  else
    -- guard: ต้องเป็นรุ่น 0116 (ใช้ helper penalty_accrual_for_installment + อัปเดต current_grade) ไม่งั้นไม่แตะ
    if position('penalty_accrual_for_installment' in v_def) = 0
       or position('current_grade' in v_def) = 0
       or position('penalty_accrual_today' in v_def) = 0 then
      raise exception '0188: run_daily_update บน prod ไม่ใช่รุ่น 0116 ที่คาดไว้ -- หยุด ไม่แตะ';
    end if;
    v_def := regexp_replace(v_def, 'FUNCTION public\.run_daily_update\(\)', 'FUNCTION public.run_daily_update_body()');
    if position('run_daily_update_body' in v_def) = 0 then
      raise exception '0188: เปลี่ยนชื่อเนื้อฟังก์ชันไม่สำเร็จ';
    end if;
    execute v_def;
  end if;
end
$mig$;

revoke all on function public.run_daily_update_body() from public, anon, authenticated;
grant execute on function public.run_daily_update_body() to service_role;
comment on function public.run_daily_update_body() is
  '(0188) เนื้อ run_daily_update รุ่น 0116 ทุกตัวอักษร (คัดจาก prod ตอน apply) เรียกจาก run_daily_update() เท่านั้น';

create or replace function public.run_daily_update()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_try int := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      -- ล็อกสัญญา active เรียงตาม id ก่อนแตะงวด (สัญญา -> งวด) ตรงกับทางลงเงิน/แก้ค่าปรับ
      -- ล็อกชนิด FOR UPDATE เดียวกับ trigger 0171 และ 0185 (ไม่ต้องอัปเกรดล็อกกลาง tx ตอน trigger ล็อกสัญญาที่ข้อ 4)
      perform 1 from public.contracts where status = 'active' order by id for update;
      perform public.run_daily_update_body();
      return;
    exception when deadlock_detected then
      -- subtransaction rollback เฉพาะรอบนี้ (ล็อก/ค่าปรับที่แก้ไปคืนหมด) แล้วลองใหม่ ครบ 3 รอบค่อยให้ cron เห็น error
      if v_try >= 3 then
        raise;
      end if;
      raise warning 'run_daily_update: deadlock รอบที่ % ลองใหม่', v_try;
      perform pg_sleep(v_try * 2);
    end;
  end loop;
end;
$$;

revoke execute on function public.run_daily_update() from public, anon, authenticated;
grant execute on function public.run_daily_update() to service_role;
comment on function public.run_daily_update() is
  '(0188) ตัวห่อ cron รายวัน: ล็อกสัญญา active เรียง id -> เรียก run_daily_update_body() (เนื้อ 0116 เดิม) ; deadlock 40P01 retry สูงสุด 3 รอบ';

-- ความเห็นเดิมของ run_daily_update (0116) ไปอยู่ที่ body ด้วยการ comment ข้างบนแล้ว

-- Verify หลัง apply:
-- select proname, prosecdef, proacl::text from pg_proc where pronamespace='public'::regnamespace
--  and proname in ('run_daily_update','run_daily_update_body','admin_set_installment_penalty','staff_set_installment_penalty','pj_review_set_penalty');
-- expected: anon/PUBLIC ไม่มี EXECUTE ทุกตัว; run_daily_update(+_body) มีเฉพาะ postgres + service_role
