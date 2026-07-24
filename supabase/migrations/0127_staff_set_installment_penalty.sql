-- 0127: RPC ให้ staff แก้ค่าปรับรายงวดได้ (จำกัดขอบเขต) เพื่อรับชำระได้จริง (Pete อนุมัติ 24 ก.ค. 2026, แบมสเปค)
--
-- ============================================================================
-- บริบท:
--   ตอนนี้แก้ค่าปรับรายงวดผ่านเว็บได้ทางเดียวคือ admin_set_installment_penalty (0096) ซึ่ง guard
--   is_admin() เข้ม — staff หน้างานที่รับเงินลูกค้าโดยตรง (เจอค่าปรับที่ตั้งไว้ไม่ตรงยอดจริงที่ต้องเก็บ
--   เช่น ลูกค้าจ่ายบางส่วนมาก่อนหน้า) ไม่มีทางแก้ค่าปรับก่อนรับชำระเลย ต้องรอ admin ว่าง
--
--   งานนี้เปิด RPC ใหม่ role-aware — admin ยังมีอำนาจเดิมทุกกรณี (รวม returned/งวดปิด, ไม่ผูก guard
--   เพิ่ม) ส่วน staff ได้สิทธิ์แคบกว่า: เฉพาะสัญญา active + งวดที่เงินต้นยังไม่ปิด + ห้ามตั้งค่าปรับต่ำกว่า
--   ยอดที่เก็บไปแล้วจริง (กันโกง/พลาดทำให้ยอดเก็บแล้ว > ยอดที่ตั้งไว้ ซึ่งจะทำให้ตัวเลขรายงานเพี้ยน)
--
--   ไม่แตะ/ลบ 0096 (ยังเป็นทางของ admin เดิม, cap 5000+audit table เดียวกัน) — เพิ่ม RPC ใหม่แบบ
--   additive คนละชื่อ ไม่ทับ signature เดิม ไม่กระทบ caller เดิม (ContractDetail ฝั่ง admin ยังเรียก
--   admin_set_installment_penalty ได้ปกติถ้าไม่เปลี่ยน — การเปลี่ยน caller เป็นงานของน้องวิว/db.ts แยก)
--
-- ต่างจาก 0096:
--   - ไม่ guard is_admin() อย่างเดียว — เช็ค profiles.role ของผู้เรียกเอง ต้องเป็น 'admin' หรือ 'staff'
--     เท่านั้น (freelancer/accounting/executive ผ่านไม่ได้) reject ด้วยข้อความ 'ไม่มีสิทธิ์แก้ค่าปรับ'
--   - บังคับ p_reason ไม่ว่างเสมอ (ทั้ง admin/staff) — 0096 ไม่ได้บังคับ (client เดิมอาจส่ง reason ว่างได้
--     ในทางทฤษฎี) ทางนี้เข้มกว่าเพราะเปิดให้ staff ใช้ด้วย ต้องมี audit ชัดเจนทุกครั้ง
--   - role='staff' โดนอีก 3 ด่านที่ admin ไม่โดน (contract ต้อง active, งวดต้องยังไม่ปิด(paid_at is null),
--     ตั้งค่าปรับต่ำกว่ายอดที่เก็บไปแล้วจริงไม่ได้) — กันไม่ให้ staff ไปยุ่งกับสัญญาที่คืนเครื่อง/ปิดแล้ว
--     (ด่าน active คือตัวกันหลักไม่ให้ staff แตะสัญญา returned/closed) หรือทำยอดค่าปรับข้อมูลเพี้ยน
--   - penalty_days คำนวณจาก app_settings.penalty_per_day (ไม่ hardcode 100) — ตัวแปรเดียวกับที่
--     penalty_accrual_for_installment (0116) และ pj_review_set_penalty (0117) ใช้ + ตรงกับ
--     DEFAULT_PENALTY_PER_DAY ฝั่ง TS (src/lib/calc.ts บรรทัด 435) ที่ mirror ค่าเดียวกัน — ถ้าวันหน้า
--     Pete เปลี่ยนอัตราใน /settings ฟังก์ชันนี้ตามอัตโนมัติ ไม่ต้อง migration ใหม่
--   - cap เกิน 5000 คงไว้เหมือน 0096 (กันพิมพ์ผิดหลักเดียวกันทั้ง admin/staff)
--   - audit table เดียวกับ 0096 (penalty_override_history) — schema เดิมครบอยู่แล้ว ไม่ต้องเพิ่มคอลัมน์
--
-- Additive only — สร้างฟังก์ชันใหม่ทั้งก้อน ไม่แตะ 0096/0113/0115/0116/0117
-- ============================================================================

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

grant execute on function public.staff_set_installment_penalty(uuid, numeric, text)
  to authenticated, service_role;

comment on function public.staff_set_installment_penalty(uuid, numeric, text) is
  '(0127) แก้ค่าปรับรายงวด role-aware: admin เหมือน 0096 ทุกกรณี (รวม returned/งวดปิด), staff เฉพาะสัญญา active + งวดที่เงินต้นยังไม่ปิด (paid_at is null) + ห้ามตั้งต่ำกว่ายอดที่เก็บไปแล้วจริง (penalty_paid_for_installment 0115); reason บังคับไม่ว่างทั้งคู่; cap เกิน 5000 เหมือน 0096; penalty_days อิง app_settings.penalty_per_day; audit เข้า penalty_override_history เดียวกับ 0096';

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (MCP)
-- ============================================================================

-- a) RPC สร้างสำเร็จ:
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name='staff_set_installment_penalty';
-- expected: 1 row

-- b) authenticated มีสิทธิ์ execute (staff กดได้จริง):
-- select has_function_privilege('authenticated', 'public.staff_set_installment_penalty(uuid, numeric, text)', 'EXECUTE');
-- expected: true

-- c) trace ตามสเปค — งวดที่ penalty_amount=700, penalty_paid_for_installment=300, สัญญา active, paid_at is null:
--    ทดสอบผ่าน session staff จริง (is auth.uid() ของ staff) — service_role ข้าม guard role เพราะไม่มี auth.uid()
--    ที่ map เป็น profile staff ได้ในตัว SQL Editor ตรงๆ ต้องทดสอบผ่านแอปจริง/JWT staff เท่านั้น:
--   begin;
--     select penalty_amount from public.installments where id = '<installment_id>'; -- ก่อน: 700
--     select public.staff_set_installment_penalty('<installment_id>'::uuid, 250, 'ทดสอบ ครีม');
--     -- expected: ERROR ตั้งค่าปรับต่ำกว่ายอดที่เก็บไปแล้วไม่ได้ (เก็บแล้ว 300 บาท)
--     select public.staff_set_installment_penalty('<installment_id>'::uuid, 300, 'ทดสอบ ครีม');
--     -- expected: ผ่าน — penalty_amount=300, penalty_days=round(300/100)=3, penalty_overridden=true
--     select penalty_amount, penalty_days, penalty_overridden from public.installments where id = '<installment_id>';
--   rollback;

-- d) staff แตะสัญญา returned/closed หรืองวดปิดแล้ว (paid_at not null) ต้องโดนบล็อก:
--   begin;
--     select public.staff_set_installment_penalty('<installment_id_on_returned_contract>'::uuid, 100, 'ทดสอบ');
--     -- expected: ERROR แก้ค่าปรับได้เฉพาะสัญญาที่ยัง active
--     select public.staff_set_installment_penalty('<installment_id_paid_already>'::uuid, 100, 'ทดสอบ');
--     -- expected: ERROR งวดนี้ปิดแล้ว แก้ค่าปรับไม่ได้ทางนี้
--   rollback;

-- e) admin ต้องข้าม 3 ด่านของ staff ได้หมด (สัญญา returned/งวดปิด/ต่ำกว่ายอดเก็บแล้ว) — เหมือนพฤติกรรม 0096 เดิม:
--   begin;
--     select public.staff_set_installment_penalty('<installment_id_on_returned_contract>'::uuid, 100, 'ทดสอบ admin'); -- session admin
--     -- expected: ผ่าน
--   rollback;

-- f) role อื่น (freelancer/accounting/executive) หรือไม่มี profile เลยต้องโดนบล็อก:
--   select public.staff_set_installment_penalty('<any_installment_id>'::uuid, 100, 'ทดสอบ'); -- session freelancer
--   -- expected: ERROR ไม่มีสิทธิ์แก้ค่าปรับ

-- g) reason ว่าง/ติดลบ/เกิน 5000 ต้องโดน raise เหมือน 0096:
--   select public.staff_set_installment_penalty('<installment_id>'::uuid, 100, '');    -- expected: ERROR ต้องระบุเหตุผล
--   select public.staff_set_installment_penalty('<installment_id>'::uuid, -1, 'x');    -- expected: ERROR ค่าปรับต้องไม่ติดลบ
--   select public.staff_set_installment_penalty('<installment_id>'::uuid, 5001, 'x');  -- expected: ERROR ค่าปรับสูงผิดปกติ

-- h) sanity: ไม่มี overload ซ้ำ (ตรวจ signature เดียว):
--   select p.pronargs, pg_get_function_identity_arguments(p.oid) as args
--     from pg_proc p where p.proname = 'staff_set_installment_penalty' and p.pronamespace = 'public'::regnamespace;
--   -- expected: 1 row = (uuid, numeric, text)
