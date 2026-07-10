-- 0095: ลบสัญญา (admin) + เลขกลับมาใช้ใหม่ได้ — Feature B
-- Pete decision (10 ก.ค. 2026): admin ลบได้แม้สัญญามีประวัติจ่ายเงิน/โอนร้าน แต่ต้องเตือนหนักๆ
--   ที่ UI (ไม่ hard-block ที่ backend) + สำรองก่อนลบถาวร + contract_no/inv_no กลับมาใช้ใหม่ได้
--
-- กลไก:
--   1) deleted_contracts_archive — เก็บ snapshot ถาวรก่อนลบ (JSONB ของ contract + children สำคัญ)
--      อ่านได้เฉพาะ admin, ไม่มี UPDATE/DELETE policy ให้ authenticated เลย (กันหลักฐานหาย)
--   2) RPC delete_contract(p_contract_id, p_by) — SECURITY DEFINER, guard is_admin() เท่านั้น
--      (staff/freelancer เรียกไม่ผ่าน — ต่างจาก settle_contract_early ที่ staff ทำได้ด้วย)
--      snapshot ก่อน แล้ว hard DELETE — children ที่ ON DELETE CASCADE ลบตาม FK อัตโนมัติ
--      inv_no unique index (0076) + contract_no ไม่มี unique constraint → ลบแถวจริงแล้วทั้งคู่ใช้ซ้ำได้ทันที
--   3) contracts_write (0018, FOR ALL admin+staff) เดิมรวม DELETE ด้วย → staff ลบ contract ตรงผ่าน
--      REST ได้ (latent gap). แยกเป็น 3 policy: insert/update ให้ staff คงเดิม, delete เหลือ admin เท่านั้น
--
-- Cascade children ของ contracts (verify จาก grep migrations ทั้งหมด ก่อนเขียนไฟล์นี้):
--   ON DELETE CASCADE (16 ตาราง — ลบเองอัตโนมัติ ไม่ orphan):
--     installments, device_returns, notifications, customer_addresses, collection_letters,
--     payment_log, contract_extensions, follow_ups, contract_grade_history, extra_charges,
--     penalty_override_history, contract_private_notes, queue_case_seen, inbox_pins,
--     doc_reject_log, pj_applied_ledger
--   ON DELETE SET NULL (4 ตาราง — contract_id เป็น null ไม่ลบแถว ไม่ orphan):
--     other_income, debtflow_cases, pj_payment_history, pj_sync_review.matched_contract_id
--   ไม่มี FK เลย (per-shop-day, ไม่ผูก contract_id): shop_transfer — ไม่แตะ ไม่กระทบ
--
-- ครบตาม spec ของแบม 7 ตาราง JSONB เต็ม (contract/installments/follow_ups/payment_log/
--   device_returns/extra_charges/contract_extensions) + ส่วนเสริมของชีส: other_children_counts
--   (จำนวนแถวของอีก 9 ตาราง CASCADE ที่ไม่ได้ snapshot เต็ม — เก็บไว้ตรวจสอบว่ามีอะไรหายไปบ้าง)

-- ============================================================================
-- SECTION 1: ตาราง deleted_contracts_archive (permanent — ไม่มี DELETE/UPDATE policy)
-- ============================================================================

create table if not exists public.deleted_contracts_archive (
  id                  uuid primary key default gen_random_uuid(),
  original_contract_id uuid not null,   -- ไม่ใส่ FK — contract แถวจริงถูกลบไปแล้วตอน insert แถวนี้เสร็จ
  contract_no         text not null,
  inv_no              text,
  customer_name       text not null,

  -- snapshot เต็มของ contract row ตอนก่อนลบ (รวม generated columns เช่น net_transfer)
  contract            jsonb not null,
  -- snapshot children สำคัญ (array ของแถว, [] ถ้าไม่มี)
  installments        jsonb not null default '[]'::jsonb,
  follow_ups          jsonb not null default '[]'::jsonb,
  payment_log         jsonb not null default '[]'::jsonb,
  device_returns      jsonb not null default '[]'::jsonb,
  extra_charges       jsonb not null default '[]'::jsonb,
  contract_extensions jsonb not null default '[]'::jsonb,
  -- ส่วนเสริม: จำนวนแถวของ cascade children อื่นๆ ที่ไม่ได้ snapshot เต็ม (audit ว่ามีอะไรหายไปบ้าง)
  other_children_counts jsonb not null default '{}'::jsonb,

  -- flag สรุปไว้ query เร็ว (คำนวณตอน insert — ไม่ต้อง re-derive จาก jsonb ทีหลัง)
  had_payments        boolean not null default false,
  had_device_return   boolean not null default false,
  was_transferred     boolean not null default false,

  deleted_by          text not null,   -- ชื่อผู้กดลบ (useAuth().name ฝั่ง client)
  deleted_at          timestamptz not null default now()
);

create index if not exists deleted_contracts_archive_contract_no_idx
  on public.deleted_contracts_archive (contract_no);
create index if not exists deleted_contracts_archive_deleted_at_idx
  on public.deleted_contracts_archive (deleted_at desc);

alter table public.deleted_contracts_archive enable row level security;

-- อ่านได้เฉพาะ admin — เก็บประวัติการลบไว้ตรวจสอบ ไม่ใช่ให้ staff/freelancer เห็น
drop policy if exists deleted_contracts_archive_read on public.deleted_contracts_archive;
create policy deleted_contracts_archive_read on public.deleted_contracts_archive
  for select to authenticated
  using (is_admin());

-- ไม่มี INSERT/UPDATE/DELETE policy ให้ authenticated เลย
--   → ทุกคน (รวม admin) เขียน/ลบแถวใน archive ผ่าน REST ตรงๆ ไม่ได้
--   → แถวเดียวที่เข้ามาได้คือจาก RPC delete_contract() (SECURITY DEFINER รันเป็น owner ข้าม RLS)
--   นี่คือกลไก "ห้ามลบ/แก้หลักฐาน" ตาม spec — เจตนา ไม่ใช่ bug

-- table-level GRANT: 0005/0017 ALTER DEFAULT PRIVILEGES ครอบ authenticated + service_role
--   อัตโนมัติอยู่แล้ว (select/insert/update/delete) — RLS ด้านบนเป็นตัวคุมจริงว่าใครทำอะไรได้
--   ไม่ revoke ตรงนี้ — pattern เดียวกับตารางอื่นทั้งหมดในโปรเจกต์ (RLS-first ไม่ GRANT-first)

-- ============================================================================
-- SECTION 2: RPC delete_contract — snapshot แล้วลบถาวร
-- ============================================================================
-- SECURITY DEFINER = รันด้วย owner privileges (bypass RLS บน contracts + children + archive)
-- guard ภายใน: is_admin() เท่านั้น (ต่างจาก settle_contract_early/close_returned_contract ที่ staff ทำได้ด้วย
--   — ลบถาวรเป็นความเสี่ยงสูงกว่า Pete ล็อกไว้ admin เท่านั้นตาม spec)
-- ไม่ hard-block แม้มีประวัติจ่าย/โอน (Pete: เตือนที่ UI ก่อนเรียก RPC นี้แทน)
-- คืนค่า contract_no ที่เพิ่งปลดออกมา (ให้ UI toast "ปลดเลข XXX แล้ว")

create or replace function public.delete_contract(
  p_contract_id uuid,
  p_by          text
)
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_contract              contracts%rowtype;
  v_had_payments          boolean;
  v_had_device_return     boolean;
  v_was_transferred       boolean;
  v_installments_json     jsonb;
  v_follow_ups_json       jsonb;
  v_payment_log_json      jsonb;
  v_device_returns_json   jsonb;
  v_extra_charges_json    jsonb;
  v_contract_extensions_json jsonb;
  v_other_counts          jsonb;
begin
  -- SECURITY GUARD: admin เท่านั้น (staff/freelancer เรียกไม่ผ่าน)
  if not is_admin() then
    raise exception 'permission denied: delete_contract requires admin role';
  end if;

  if p_by is null or length(trim(p_by)) = 0 then
    raise exception 'p_by (ชื่อผู้ลบ) ห้ามว่าง';
  end if;

  -- ล็อกแถว + โหลด snapshot หลัก
  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญานี้: %', p_contract_id;
  end if;

  -- flags สรุป (คำนวณก่อนลบ — ต้องอ่านจาก children ที่ยังอยู่)
  v_had_payments := exists (
    select 1 from public.payment_log where contract_id = p_contract_id and action = 'pay'
  );
  v_had_device_return := exists (
    select 1 from public.device_returns where contract_id = p_contract_id
  );
  v_was_transferred := (v_contract.summary_shop_sent_at is not null
                         or v_contract.summary_accounting_sent_at is not null);

  -- snapshot children สำคัญ (7 ตารางตาม spec) เป็น jsonb array
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_installments_json
    from public.installments t where t.contract_id = p_contract_id;
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_follow_ups_json
    from public.follow_ups t where t.contract_id = p_contract_id;
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_payment_log_json
    from public.payment_log t where t.contract_id = p_contract_id;
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_device_returns_json
    from public.device_returns t where t.contract_id = p_contract_id;
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_extra_charges_json
    from public.extra_charges t where t.contract_id = p_contract_id;
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_contract_extensions_json
    from public.contract_extensions t where t.contract_id = p_contract_id;

  -- ส่วนเสริม: จำนวนแถวของ cascade children อื่นๆ ที่ไม่ snapshot เต็ม (audit ว่ามีอะไรหายไปบ้าง)
  select jsonb_build_object(
    'notifications',            (select count(*) from public.notifications where contract_id = p_contract_id),
    'customer_addresses',       (select count(*) from public.customer_addresses where contract_id = p_contract_id),
    'collection_letters',       (select count(*) from public.collection_letters where contract_id = p_contract_id),
    'contract_grade_history',   (select count(*) from public.contract_grade_history where contract_id = p_contract_id),
    'penalty_override_history', (select count(*) from public.penalty_override_history where contract_id = p_contract_id),
    'contract_private_notes',   (select count(*) from public.contract_private_notes where contract_id = p_contract_id),
    'queue_case_seen',          (select count(*) from public.queue_case_seen where contract_id = p_contract_id),
    'inbox_pins',               (select count(*) from public.inbox_pins where contract_id = p_contract_id),
    'doc_reject_log',           (select count(*) from public.doc_reject_log where contract_id = p_contract_id),
    'pj_applied_ledger',        (select count(*) from public.pj_applied_ledger where contract_id = p_contract_id)
  ) into v_other_counts;

  -- เขียน archive ก่อนลบจริง (ถ้า insert fail ทั้ง transaction rollback — ไม่มีทาง lose data)
  insert into public.deleted_contracts_archive (
    original_contract_id, contract_no, inv_no, customer_name,
    contract, installments, follow_ups, payment_log, device_returns,
    extra_charges, contract_extensions, other_children_counts,
    had_payments, had_device_return, was_transferred,
    deleted_by
  ) values (
    v_contract.id, v_contract.contract_no, v_contract.inv_no, v_contract.customer_name,
    to_jsonb(v_contract), v_installments_json, v_follow_ups_json, v_payment_log_json, v_device_returns_json,
    v_extra_charges_json, v_contract_extensions_json, v_other_counts,
    v_had_payments, v_had_device_return, v_was_transferred,
    p_by
  );

  -- ลบถาวร — children ที่ ON DELETE CASCADE ลบตาม FK อัตโนมัติ (ดู comment หัวไฟล์)
  -- inv_no (unique index 0076) + contract_no ปลดออกทันทีหลังบรรทัดนี้สำเร็จ
  delete from public.contracts where id = p_contract_id;

  return v_contract.contract_no;
end;
$$;

grant execute on function public.delete_contract(uuid, text) to authenticated, service_role;

-- ============================================================================
-- SECTION 3: contracts_write (0018) → แยก DELETE ให้เหลือ admin เท่านั้น
-- ============================================================================
-- เดิม (0018): contracts_write FOR ALL to authenticated using/with check (is_admin() OR staff)
--   → รวม DELETE ด้วย = staff ลบ contract ตรงผ่าน REST ได้ (latent gap ที่ต้องปิด)
-- ใหม่: แยกเป็น insert/update (คง admin+staff เหมือนเดิมทุกประการ) + delete (admin เท่านั้น)
-- contracts_read (0092) แยกต่างหากอยู่แล้ว ไม่กระทบ

drop policy if exists contracts_write on public.contracts;

create policy contracts_insert on public.contracts for insert to authenticated
  with check (
    is_admin() OR ((select role from public.profiles where id = auth.uid()) = 'staff')
  );

create policy contracts_update on public.contracts for update to authenticated
  using (
    is_admin() OR ((select role from public.profiles where id = auth.uid()) = 'staff')
  )
  with check (
    is_admin() OR ((select role from public.profiles where id = auth.uid()) = 'staff')
  );

create policy contracts_delete on public.contracts for delete to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 4: Verify checklist สำหรับติ๊ก/ครีม รันหลัง apply ผ่าน MCP (ไม่รันในไฟล์นี้)
-- ============================================================================

-- 4a) service_role เข้าถึง archive table ได้ (Edge Function ในอนาคตถ้ามี):
-- SELECT has_table_privilege('service_role', 'public.deleted_contracts_archive', 'SELECT');
--   expected: true

-- 4b) policy ครบตามที่ตั้งใจบน contracts (ต้องเห็น 4 ชื่อ ไม่มี contracts_write เดิมแล้ว):
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'contracts' ORDER BY policyname;
--   expected: contracts_delete(d) / contracts_insert(a="INSERT") / contracts_read(r) / contracts_update(w)

-- 4c) staff เรียก DELETE ตรงผ่าน REST ต้องโดนบล็อก (ทดสอบด้วย session staff จริง):
-- DELETE FROM contracts WHERE id = '<test-contract-id>';  -- ในฐานะ staff
--   expected: 0 rows affected (RLS filter ทิ้งก่อนถึง DELETE จริง — ไม่ error แค่ไม่มีอะไรถูกลบ)

-- 4d) admin เรียก RPC สำเร็จ + archive มีแถว + contract_no ใช้ซ้ำได้:
-- SELECT delete_contract('<test-contract-id>', 'ทดสอบ ครีม');
--   expected: คืน contract_no เดิม
-- SELECT count(*) FROM contracts WHERE id = '<test-contract-id>';           -- expected: 0
-- SELECT count(*) FROM installments WHERE contract_id = '<test-contract-id>'; -- expected: 0 (cascade)
-- SELECT contract_no, had_payments, had_device_return, was_transferred
--   FROM deleted_contracts_archive WHERE original_contract_id = '<test-contract-id>';
--   expected: 1 row, flags ตรงกับสถานะจริงของสัญญาก่อนลบ

-- 4e) staff/freelancer เรียก RPC ต้องโดนบล็อกด้วย exception (ไม่ใช่แค่ RLS เงียบๆ):
-- SELECT delete_contract('<any-contract-id>', 'ทดสอบ staff');  -- ในฐานะ staff
--   expected: ERROR permission denied: delete_contract requires admin role

-- 4f) contract_no ซ้ำสร้างใหม่ได้จริงหลังลบ (ไม่มี unique constraint บน contract_no อยู่แล้ว — sanity check):
-- INSERT INTO contracts (contract_no, customer_name) VALUES ('<contract_no ที่เพิ่งปลด>', 'ทดสอบใช้เลขซ้ำ');
--   expected: สำเร็จ ไม่มี unique violation

-- 4g) staff/freelancer อ่าน archive ไม่ได้ (ทดสอบ session staff):
-- SELECT count(*) FROM deleted_contracts_archive;  -- ในฐานะ staff
--   expected: 0 rows (RLS block — ไม่ error แค่ไม่เห็นอะไร)
