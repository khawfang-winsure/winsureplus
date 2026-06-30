-- 0078: ปิดสัญญาก่อนกำหนด + ส่วนลด (Early Settlement) — Wave 1 หลังบ้าน
-- Pete เคาะกฎ:
--   ลูกค้าอยากปิดสัญญาก่อนครบงวด → ให้ส่วนลดเงินต้นที่เหลือตามจำนวนงวดที่เหลือ
--   ส่วนลดคิดจากเงินต้นที่เหลือเท่านั้น (ค่าปรับค้างไม่ลด)
--   pure function computeSettlement (src/lib/settlement.ts) คิดยอด, RPC นี้ลงบันทึก
--
-- additive ทั้งหมด (add column if not exists / create or replace / insert ถ้ายังไม่มี)
-- public.* ได้ default privileges จาก 0017 อยู่แล้ว → ไม่ต้อง grant table เพิ่ม

-- ============================================================================
-- 1) คอลัมน์เก็บผลการปิดสัญญาบน contracts (audit ยอดที่คิดตอนปิด)
-- ============================================================================
alter table public.contracts
  add column if not exists settled_at          timestamptz,
  add column if not exists settlement_discount numeric,
  add column if not exists settlement_remaining numeric,
  add column if not exists settlement_paid     numeric,
  add column if not exists settled_by          text;

-- ธงงวดที่ถูกปิดด้วยการ settle (แยกจากงวดจ่ายปกติ — ไว้ดูย้อนหลัง/รายงาน)
alter table public.installments
  add column if not exists settled boolean default false;

-- ============================================================================
-- 2) seed ชั้นส่วนลด (settlement_tiers) ลง app_settings — idempotent
--    เหลือ >= 5 งวด → 7% , เหลือ >= 10 งวด → 10%
-- ============================================================================
insert into public.app_settings (key, value, description)
select
  'settlement_tiers',
  '[{"minRemaining":5,"percent":7},{"minRemaining":10,"percent":10}]',
  'ชั้นส่วนลดปิดสัญญาก่อนกำหนด (เหลือกี่งวดขึ้นไป → ส่วนลด %)'
where not exists (
  select 1 from public.app_settings where key = 'settlement_tiers'
);

-- ============================================================================
-- 3) RPC settle_contract_early — ปิดสัญญาก่อนกำหนดใน transaction เดียว
--    SECURITY DEFINER = รันด้วย owner privileges (bypass RLS บน contracts/installments)
--    guard ภายในเช็ค is_admin() OR is_staff() กัน freelancer เรียก RPC โดยตรง
--    ทำเฉพาะถ้า contract.status = 'active' เท่านั้น (กันกดพลาดสถานะอื่น)
-- ============================================================================
create or replace function public.settle_contract_early(
  p_contract_id uuid,
  p_remaining   numeric,  -- เงินต้นที่เหลือ (ก่อนหักส่วนลด) — มาจาก computeSettlement ฝั่ง client
  p_discount    numeric,  -- ส่วนลดเป็นบาท
  p_paid        numeric,  -- ลูกค้าจ่ายปิดจริง = remaining − discount + penalty (เงินสดที่รับ)
  p_penalty     numeric,  -- ค่าปรับค้างที่รับครั้งนี้
  p_by          text      -- ชื่อผู้กดปิด (useAuth().name ฝั่ง client)
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_status text;
  v_target uuid;   -- งวดสุดท้ายที่ยังค้าง — ผูก payment_log (ห้าม null)
  v_target_amount numeric;
begin
  -- SECURITY GUARD: freelancer ห้ามเรียก RPC นี้
  if not (is_admin() or is_staff()) then
    raise exception 'permission denied: settle_contract_early requires admin or staff role';
  end if;

  -- เช็คสถานะสัญญา — ต้องเป็น active เท่านั้น
  select status into v_status from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'contract not found: %', p_contract_id;
  end if;
  if v_status <> 'active' then
    raise exception 'contract not active (status=%): %', v_status, p_contract_id;
  end if;

  -- 1) งวดสุดท้ายที่ยังค้าง (installment_no มากสุดที่ paid_at IS NULL) — ไว้ผูก payment_log
  select id, amount into v_target, v_target_amount
    from public.installments
   where contract_id = p_contract_id
     and paid_at is null
   order by installment_no desc
   limit 1;

  if v_target is null then
    raise exception 'no unpaid installment to settle: %', p_contract_id;
  end if;

  -- 2) ปิดทุกงวดที่ยังค้าง → outstanding=0, X/Y ครบ
  update public.installments
     set paid_amount = amount,
         status      = 'paid',
         settled     = true,
         paid_at     = now()
   where contract_id = p_contract_id
     and paid_at is null;

  -- 3) INSERT payment_log แถวเดียว = เงินสดจริง (p_paid)
  --    ⚠️ installment_id ห้าม null (null = ระบบนับเป็นเงินดาวน์ใน sale-history)
  --    ⚠️ INSERT แค่ก้อนเดียว = p_paid เพื่อไม่ให้รายได้ v_cashflow_daily เฟ้อ (ห้าม insert ก้อนส่วนลด)
  insert into public.payment_log (
    contract_id,
    installment_id,
    action,
    amount,
    penalty_paid_amount,
    paid_amount_after,
    by_name,
    note,
    created_at
  ) values (
    p_contract_id,
    v_target,
    'pay',
    p_paid,
    p_penalty,
    v_target_amount,
    p_by,
    'ปิดสัญญาก่อนกำหนด (ส่วนลด ' || p_discount || ')',
    now()
  );

  -- 4) ปิดสัญญา + เก็บ audit ยอดที่คิด
  update public.contracts
     set status               = 'closed',
         settled_at           = now(),
         settlement_discount  = p_discount,
         settlement_remaining = p_remaining,
         settlement_paid      = p_paid,
         settled_by           = p_by
   where id = p_contract_id;
end;
$$;

-- Grant execute (ลอก 0072)
grant execute on function public.settle_contract_early(uuid, numeric, numeric, numeric, numeric, text)
  to authenticated, service_role;

comment on function public.settle_contract_early(uuid, numeric, numeric, numeric, numeric, text)
  is 'ปิดสัญญาก่อนกำหนด: ปิดงวดค้างทั้งหมด + บันทึกเงินรับ 1 ก้อน + flip active→closed. guard admin/staff';

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (commented)
-- ============================================================================

-- a) คอลัมน์ใหม่บน contracts มีจริง:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='contracts'
--     AND column_name IN ('settled_at','settlement_discount','settlement_remaining','settlement_paid','settled_by');
-- expected: 5 rows

-- b) คอลัมน์ settled บน installments มีจริง:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='installments' AND column_name='settled';
-- expected: 1 row

-- c) seed tiers เข้าแล้ว:
-- SELECT value FROM public.app_settings WHERE key='settlement_tiers';
-- expected: [{"minRemaining":5,"percent":7},{"minRemaining":10,"percent":10}]

-- d) RPC สร้างสำเร็จ + authenticated execute ได้:
-- SELECT has_function_privilege('authenticated',
--   'public.settle_contract_early(uuid, numeric, numeric, numeric, numeric, text)', 'EXECUTE');
-- expected: true
