-- 0117: RPC ตั้งค่าปรับรายงวดสำหรับ "ลงตาม PJ" ในกล่องรอตรวจ — staff ใช้ได้ด้วย (Pete ยืนยัน 18 ก.ค. 2026)
--
-- ============================================================================
-- บริบท:
--   Pete เลือก "ยึด PJ เป็นหลัก" — ถ้า PJ คิดค่าปรับต่างจากที่ระบบเราคิด (เช่น รวินทร์นิภา PJ=229 เราคิด=700)
--   กด "ลงตาม PJ" ในกล่องรอตรวจ ต้อง set penalty_amount ของงวดเป้าหมาย = ยอด PJ ให้ตรงกัน (align)
--
--   เดิมมี admin_set_installment_penalty (0096) ทำสิ่งนี้ได้ แต่ guard is_admin() เข้ม — staff ที่เปิด
--   หน้า /pj-sync-review (0087 เปิดให้ staff ใช้กล่องรอตรวจอยู่แล้ว) กดแล้ว fail เงียบ (permission denied)
--   จึงถอด align ออกจาก applyPjReviewPayment ไปก่อน (18 ก.ค. 2026, ดู comment เดิมใน db.ts)
--
--   งานนี้เปิด RPC ใหม่ scope แคบกว่า 0096 — ใช้เฉพาะ path "ลงตาม PJ" กล่องรอตรวจ (ยึด PJ เป็น truth ที่
--   ผ่านการตรวจสอบ reason=AMOUNT_MISMATCH มาแล้วในชั้น UI/db.ts) ไม่ใช่ admin override ทั่วไปแบบ 0096
--   (0096 ยังอยู่เหมือนเดิม ไม่แตะ — ยังเป็นทางแก้/ลบค่าปรับมือของ admin จากหน้าอื่น)
--
-- ต่างจาก 0096:
--   - ไม่มี guard is_admin() — grant execute ให้ authenticated (staff+admin เรียกได้) + service_role
--   - ไม่มี cap เกิน 5000 / ไม่มี audit table แยก (penalty_override_history เป็นของ 0096 โดยเฉพาะ ไม่ผูกที่นี่
--     เพราะ path นี้มี payment_log ของ record_payment_spread เป็น audit trail หลักอยู่แล้ว)
--   - penalty_days คำนวณจาก app_settings.penalty_per_day (ไม่ hardcode 100 เหมือน 0096 เดิม) — เผื่ออนาคต
--     เปลี่ยนอัตรา ให้ตรงกับที่ 0116 (penalty_accrual_for_installment) ใช้อยู่แล้ว
--
-- Additive only — create or replace function ใหม่ทั้งก้อน ไม่แตะ 0096/0113/0115/0116
-- ============================================================================

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
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'ค่าปรับต้องไม่ติดลบ: %', p_amount;
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

-- grant กว้างกว่า 0096 โดยตั้งใจ — scope แคบ (ตั้งค่าปรับตรงๆ ไม่มี business logic อื่น) ใช้เฉพาะ
-- path "ลงตาม PJ" กล่องรอตรวจ ที่ทั้ง staff และ admin ต้องกดได้
grant execute on function public.pj_review_set_penalty(uuid, numeric)
  to authenticated, service_role;

comment on function public.pj_review_set_penalty(uuid, numeric) is
  '(0117) ตั้ง penalty_amount+penalty_days+penalty_overridden=true ของ 1 งวดตรงๆ — scoped สำหรับปุ่ม "ลงตาม PJ" ในกล่องรอตรวจ (ยึด PJ เป็น truth, เรียกจาก applyPjReviewPayment หลัง record_payment_spread สำเร็จ) grant authenticated ทั้ง staff+admin ต่างจาก admin_set_installment_penalty (0096) ที่ admin-only + มี audit table + cap 5000 (ใช้จากหน้าแก้ค่าปรับมือของ admin คนละ path)';

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP)
-- ============================================================================

-- a) RPC สร้างสำเร็จ:
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name='pj_review_set_penalty';
-- expected: 1 row

-- b) authenticated มีสิทธิ์ execute (staff กดได้จริง):
-- select has_function_privilege('authenticated', 'public.pj_review_set_penalty(uuid, numeric)', 'EXECUTE');
-- expected: true

-- c) service_role มีสิทธิ์ execute:
-- select has_function_privilege('service_role', 'public.pj_review_set_penalty(uuid, numeric)', 'EXECUTE');
-- expected: true

-- d) smoke ทดสอบตั้งค่าปรับ (แทน <installment_id> จริงที่มี penalty_amount ปัจจุบัน แล้ว rollback ทันที):
-- begin;
--   select penalty_amount, penalty_days, penalty_overridden from public.installments where id = '<installment_id>'; -- ค่าก่อน
--   select public.pj_review_set_penalty('<installment_id>'::uuid, 229);
--   select penalty_amount, penalty_days, penalty_overridden from public.installments where id = '<installment_id>';
--   -- expected: penalty_amount=229, penalty_days=round(229/100)=2, penalty_overridden=true
-- rollback;

-- e) ติดลบต้อง raise:
-- select public.pj_review_set_penalty('<installment_id>'::uuid, -1);
-- expected: ERROR ค่าปรับต้องไม่ติดลบ

-- f) installment ไม่มีจริงต้อง raise:
-- select public.pj_review_set_penalty('00000000-0000-0000-0000-000000000000'::uuid, 100);
-- expected: ERROR ไม่พบงวดผ่อนนี้
