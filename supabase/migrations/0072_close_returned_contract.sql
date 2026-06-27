-- 0072: RPC close_returned_contract — ปิดสัญญาเคสคืนเครื่องเมื่อรับเงินครบ
-- Pete เคาะ: คืนเครื่องแล้วแต่ยังค้างยอด → เด้งคิวฟรีแลนซ์ตามเก็บ →
--   รับเงินครบ → กดปุ่มยืนยันปิด → status returned → returned_closed
--
-- SECURITY DEFINER = รันด้วย owner privileges (bypass RLS บน contracts)
-- guard ภายในเช็ค is_admin() OR is_staff() กัน freelancer เรียก RPC โดยตรง
-- flip เฉพาะ returned → returned_closed เท่านั้น (where status='returned')
--   กันกดพลาดสถานะอื่น (active/closed/online ไม่กระทบ)

create or replace function public.close_returned_contract(
  p_contract_id uuid,
  p_by          text   -- ชื่อผู้กดปิด (useAuth().name ฝั่ง client)
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- SECURITY GUARD: freelancer ห้ามเรียก RPC นี้
  if not (is_admin() or is_staff()) then
    raise exception 'permission denied: close_returned_contract requires admin or staff role';
  end if;

  -- flip เฉพาะ returned → returned_closed
  update public.contracts
     set status = 'returned_closed'
   where id = p_contract_id
     and status = 'returned';

  -- ไม่เจอแถว = สัญญาไม่อยู่สถานะ returned (หรือไม่มี id นี้) → กันกดพลาด
  if not found then
    raise exception 'contract not in returned state (or not found): %', p_contract_id;
  end if;
end;
$$;

-- Grant execute
grant execute on function public.close_returned_contract(uuid, text)
  to authenticated, service_role;

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- a) RPC สร้างสำเร็จ:
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public' AND routine_name = 'close_returned_contract';
-- expected: 1 row

-- b) authenticated มีสิทธิ์ execute:
-- SELECT has_function_privilege('authenticated',
--   'public.close_returned_contract(uuid, text)', 'EXECUTE');
-- expected: true
