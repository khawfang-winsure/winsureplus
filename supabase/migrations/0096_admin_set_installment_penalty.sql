-- 0096: RPC ให้ Admin แก้/ลบค่าปรับรายงวดผ่านเว็บได้ (Pete อนุมัติ 10 ก.ค. 2026)
-- บริบท: ค่าปรับคิดรายงวด 100 บาท/วัน สูงสุด 7 วัน = เพดาน 700/งวด (บางเคสพิเศษ 800/900 — ไม่ hard-cap ที่นี่)
--   ปัจจุบัน Admin ไม่มีทางแก้/ลบค่าปรับผ่านหน้าเว็บเลย ต้องแก้ตรง DB หลังบ้าน — งานนี้เปิดช่องทางที่ปลอดภัยกว่า
--
-- หมายเหตุ: db.ts มีฟังก์ชัน overridePenalty() เดิมอยู่แล้ว (ใช้ .update() ตรงผ่าน RLS installments_write
--   ซึ่งเปิดให้ staff เขียนได้ด้วย ไม่ใช่ admin เท่านั้น) — RPC นี้เป็นทางที่สองที่ guard เข้มกว่า (admin เท่านั้น)
--   ไม่แตะ/ลบของเดิม เพิ่มเป็นทางเลือกใหม่แบบ additive
--
-- penalty_override_history (0036) มีคอลัมน์ครบสำหรับ audit อยู่แล้ว ไม่ต้องเพิ่มคอลัมน์:
--   id, installment_id, contract_id, old_amount, new_amount, reason, by_name, created_at
--
-- "ลบค่าปรับ" = เรียก RPC นี้ด้วย p_penalty_amount = 0 (ไม่มี RPC แยกสำหรับลบ — ฟังก์ชันเดียวครอบคลุมทั้งแก้และลบ)
--
-- penalty_days คำนวณย้อนจาก penalty_amount ด้วยอัตรา 100 บาท/วัน (ปัดเศษ round) — เก็บไว้ให้ตรงกับ
--   คอลัมน์เดิมที่ใช้แสดงผล/รายงานอื่นๆ ในระบบ ถึงแม้ admin จะพิมพ์ยอดที่ไม่ลงตัวกับ 100/วัน พอดีก็ตาม
-- penalty_overridden = true ทุกครั้งที่เรียก RPC นี้ — กัน run_daily_update() (0031) มาคิดทับค่าที่ admin ตั้งเอง

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

grant execute on function public.admin_set_installment_penalty(uuid, numeric, text)
  to authenticated, service_role;

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (MCP)
-- ============================================================================

-- a) RPC สร้างสำเร็จ:
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name='admin_set_installment_penalty';
-- expected: 1 row

-- b) authenticated มีสิทธิ์ execute:
-- select has_function_privilege('authenticated', 'public.admin_set_installment_penalty(uuid, numeric, text)', 'EXECUTE');
-- expected: true

-- c) smoke ทดสอบแก้ค่าปรับ (แทน <installment_id> จริงที่มี penalty_amount > 0 แล้ว rollback กลับค่าเดิมทันที
--    ผ่าน service_role/Studio — service_role ไม่ใช่ authenticated จริง แต่ is_admin() เช็ค auth.uid()
--    จาก JWT ดังนั้นต้อง set role/JWT claim จำลอง admin หรือทดสอบผ่าน RPC เดียวกันด้วย session admin จริงแทน):
-- select penalty_amount, penalty_days, penalty_overridden from public.installments where id = '<installment_id>'; -- ค่าก่อน
-- select public.admin_set_installment_penalty('<installment_id>'::uuid, 250, 'ทดสอบ ครีม');
-- select penalty_amount, penalty_days, penalty_overridden from public.installments where id = '<installment_id>';
-- expected: penalty_amount=250, penalty_days=3 (round(250/100)=3), penalty_overridden=true
-- select * from public.penalty_override_history where installment_id = '<installment_id>' order by created_at desc limit 1;
-- expected: 1 แถวใหม่ old_amount=ค่าก่อน, new_amount=250, reason='ทดสอบ ครีม'
-- -- rollback กลับค่าเดิม:
-- select public.admin_set_installment_penalty('<installment_id>'::uuid, <ค่าเดิม>, 'rollback หลังทดสอบ');

-- d) staff/freelancer เรียก RPC ต้องโดนบล็อกด้วย exception:
-- select public.admin_set_installment_penalty('<any_installment_id>'::uuid, 100, 'ทดสอบ staff');  -- ในฐานะ staff
-- expected: ERROR permission denied: admin_set_installment_penalty requires admin role

-- e) ติดลบ/เกิน 5000 ต้องถูก raise:
-- select public.admin_set_installment_penalty('<installment_id>'::uuid, -1, 'x');   -- expected: ERROR ค่าปรับต้องไม่ติดลบ
-- select public.admin_set_installment_penalty('<installment_id>'::uuid, 5001, 'x'); -- expected: ERROR ค่าปรับสูงผิดปกติ
