-- 0094: RPC แก้ "วันที่โอน" ของสัญญาให้ตรงกับที่ /transfers ใช้จริง (แก้บั๊ก: ปุ่มเดิมแก้ transaction_date คนละคอลัมน์กับที่หน้าจอ group)
-- /transfers (getDailyTransferByShop / getDailyTransferContracts) group ยอดรายวันด้วย contracts.summary_accounting_sent_at
-- ไม่ใช่ transaction_date (วันขาย ที่ weekly-summary ใช้) — ปุ่ม "แก้วันที่โอน" เดิมแก้ transaction_date จึงไม่ย้ายยอดบนหน้าจอเลย
-- ตัดสินใจ: แก้เฉพาะ summary_accounting_sent_at (ไม่แตะ transaction_date/วันขาย — คนละความหมาย ไม่อยากให้ weekly-summary เพี้ยนตามโดยไม่ตั้งใจ)
-- additive เท่านั้น — ไม่แตะ/ลบคอลัมน์เดิม เพิ่มแค่ RPC ใหม่

-- ============================================================================
-- update_contract_transfer_date(p_contract_id, p_new_date)
-- SECURITY DEFINER + guard is_admin() เท่านั้น (ปุ่มนี้ใน UI ก็โชว์เฉพาะ admin อยู่แล้ว — RPC บังคับซ้ำกัน RLS เดิม
--   ที่ contracts_write เปิดกว้างให้ staff เขียนได้ด้วย ถ้าไม่ guard ที่นี่ staff เรียกตรงผ่าน client ได้)
--
-- คงเวลานาฬิกาเดิม (ชม:นาที:วินาที ตามเขตเวลากรุงเทพ) แต่เปลี่ยนวันที่ — กัน audit event (getDailyAudit)
--   ที่อ่าน summary_accounting_sent_at ตัวเดียวกันไปโชว์เวลาเพี้ยนเป็น 00:00:00
--
-- shop_transfer: เป็น 1 แถว/ร้าน/วัน (ไม่ใช่ต่อสัญญา) — การย้ายสัญญา 1 ใบ "ย้ายสลิปตามไม่ได้" เพราะสลิปผูกกับร้าน+วัน
--   ไม่ผูกกับสัญญา ฟังก์ชันนี้ไม่แตะ shop_transfer เลย (ไม่ย้ายสลิปตาม ไม่สร้าง/ลบแถว) ปล่อยให้ยอดฝั่งแอป
--   (คำนวณสดจาก contracts) อัปเดตเองตามปกติ — Pete ตัดสินใจแล้ว (2026-07-10): ให้ admin แก้วันที่โอนได้เสมอ
--   แม้ร้านนั้นจะยืนยันโอน/แนบสลิปแล้ว (shop_transfer.transferred = true) — ยอมรับความเสี่ยงว่ายอดที่โชว์บนจอ
--   อาจไม่ตรงกับสลิปที่แนบไว้เดิม เพื่อความยืดหยุ่นในการแก้ย้อนหลัง (ไม่ block เหมือนดราฟต์แรก)
-- ============================================================================

create or replace function public.update_contract_transfer_date(
  p_contract_id uuid,
  p_new_date    date
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_old_ts   timestamptz;
  v_old_date date;
  v_new_ts   timestamptz;
begin
  -- SECURITY GUARD: เฉพาะ admin (ตรงกับที่ UI โชว์ปุ่มนี้เฉพาะ admin) — นี่คือสิทธิ์เรียก ไม่ใช่ตัวบล็อกสถานะสลิป
  if not is_admin() then
    raise exception 'permission denied: update_contract_transfer_date requires admin role';
  end if;

  select summary_accounting_sent_at
    into v_old_ts
    from public.contracts
    where id = p_contract_id
    for update;

  if not found then
    raise exception 'contract not found: %', p_contract_id;
  end if;

  if v_old_ts is null then
    raise exception 'สัญญานี้ยังไม่ได้ส่งสรุปยอดให้บัญชี ไม่มีวันที่โอนให้แก้';
  end if;

  v_old_date := (v_old_ts at time zone 'Asia/Bangkok')::date;

  -- no-op ถ้าเลือกวันเดิม
  if v_old_date = p_new_date then
    return;
  end if;

  -- เปลี่ยนวันที่ แต่คงเวลานาฬิกาเดิม (ตามเขตเวลากรุงเทพ)
  v_new_ts := (p_new_date + (v_old_ts at time zone 'Asia/Bangkok')::time) at time zone 'Asia/Bangkok';

  update public.contracts
     set summary_accounting_sent_at = v_new_ts
   where id = p_contract_id;
end;
$$;

grant execute on function public.update_contract_transfer_date(uuid, date)
  to authenticated, service_role;

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (MCP)
-- ============================================================================

-- a) RPC สร้างสำเร็จ:
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name='update_contract_transfer_date';
-- expected: 1 row

-- b) authenticated มีสิทธิ์ execute:
-- select has_function_privilege('authenticated', 'public.update_contract_transfer_date(uuid, date)', 'EXECUTE');
-- expected: true

-- c) smoke ทดสอบย้ายวันที่ปกติ — แทน <contract_id> จริงที่ summary_accounting_sent_at ไม่ null แล้วรันผ่าน service_role/Studio:
-- select public.update_contract_transfer_date('<contract_id>'::uuid, '2026-07-01'::date);
-- select summary_accounting_sent_at from public.contracts where id = '<contract_id>';
-- expected: วันที่ (Asia/Bangkok) เปลี่ยนเป็น 2026-07-01 เวลานาฬิกาเดิมคงที่ — ทำงานได้แม้ shop_transfer.transferred=true (ไม่ block)
