-- 0051: เพิ่มตาราง doc_reject_log + RPC revert_doc_receipt (ตีกลับเอกสาร/กล่อง พร้อมเหตุผล)
-- Pete เคาะ 19 มิ.ย. 2026: ตีกลับได้หลายครั้ง เก็บประวัติทุกครั้ง

-- ============================================================================
-- SECTION 1: ตาราง doc_reject_log
-- บันทึกประวัติการตีกลับเอกสาร/กล่อง (append-only log — ลบไม่ได้ผ่าน UI)
-- ============================================================================

create table if not exists public.doc_reject_log (
  id           uuid        primary key default gen_random_uuid(),
  contract_id  uuid        not null references public.contracts(id) on delete cascade,
  item_type    text        not null check (item_type in ('docs', 'box')),
  reason       text        not null,
  rejected_by  text,
  rejected_at  timestamptz not null default now()
);

create index if not exists idx_doc_reject_log_contract
  on public.doc_reject_log(contract_id);

-- ============================================================================
-- SECTION 2: RLS + GRANTs บน doc_reject_log
-- ============================================================================

alter table public.doc_reject_log enable row level security;

-- drop ก่อน กัน re-run error
drop policy if exists doc_reject_log_read  on public.doc_reject_log;
drop policy if exists doc_reject_log_write on public.doc_reject_log;

-- SELECT: admin + staff อ่านได้ (freelancer ไม่มีสิทธิ์ดูประวัติตีกลับ)
create policy doc_reject_log_read on public.doc_reject_log
  for select to authenticated
  using (is_admin() OR is_staff());

-- INSERT: admin + staff เท่านั้น (จริงๆ ผ่าน RPC ซึ่ง SECURITY DEFINER bypass RLS อยู่แล้ว
--   แต่ policy นี้เป็น belt-and-suspenders กัน direct REST call)
create policy doc_reject_log_write on public.doc_reject_log
  for insert to authenticated
  with check (is_admin() OR is_staff());

-- GRANTs สำหรับ service_role (Edge Functions) + authenticated
grant select, insert, delete on public.doc_reject_log to service_role;
grant select, insert          on public.doc_reject_log to authenticated;

-- ============================================================================
-- SECTION 3: RPC revert_doc_receipt
-- atomic: UPDATE contracts (reset flag) + INSERT doc_reject_log
-- SECURITY DEFINER = รันด้วย owner privileges (bypass RLS บน contracts)
-- guard ภายในเช็ค is_admin() OR is_staff() กัน freelancer เรียก RPC โดยตรง
-- ============================================================================

create or replace function public.revert_doc_receipt(
  p_contract_id uuid,
  p_item_type   text,   -- 'docs' หรือ 'box'
  p_reason      text,
  p_by          text    -- ชื่อผู้ตีกลับ (useAuth().name ฝั่ง client)
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- SECURITY GUARD: freelancer ห้ามเรียก RPC นี้
  if not (is_admin() or is_staff()) then
    raise exception 'permission denied: revert_doc_receipt requires admin or staff role';
  end if;

  -- Validate item_type
  if p_item_type not in ('docs', 'box') then
    raise exception 'invalid item_type: %. must be ''docs'' or ''box''', p_item_type;
  end if;

  -- UPDATE contracts — reset flag ตาม item_type
  if p_item_type = 'docs' then
    update public.contracts
       set original_docs_received    = false,
           original_docs_received_at = null,
           original_docs_received_by = null
     where id = p_contract_id;
  else
    -- 'box'
    update public.contracts
       set phone_box_received    = false,
           phone_box_received_at = null,
           phone_box_received_by = null
     where id = p_contract_id;
  end if;

  -- INSERT ประวัติการตีกลับ (ทำหลัง UPDATE กัน log ค้างเมื่อ UPDATE fail)
  insert into public.doc_reject_log (
    contract_id,
    item_type,
    reason,
    rejected_by,
    rejected_at
  ) values (
    p_contract_id,
    p_item_type,
    p_reason,
    p_by,
    now()
  );
end;
$$;

-- Grant execute
grant execute on function public.revert_doc_receipt(uuid, text, text, text)
  to authenticated, service_role;

-- ============================================================================
-- SECTION 4: Verify checklist สำหรับ Cream รันหลัง apply
-- ============================================================================

-- 4a) ตาราง + index มีครบ:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'doc_reject_log';
-- expected: 1 row

-- 4b) service_role มีสิทธิ์ SELECT:
-- SELECT has_table_privilege('service_role', 'public.doc_reject_log', 'SELECT');
-- expected: true

-- 4c) RPC สร้างสำเร็จ:
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public' AND routine_name = 'revert_doc_receipt';
-- expected: 1 row

-- 4d) RLS เปิด:
-- SELECT relrowsecurity FROM pg_class
--   WHERE oid = 'public.doc_reject_log'::regclass;
-- expected: true
