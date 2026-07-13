-- 0106: ผูก "ลงค่าธรรมเนียมเป็นรายได้" ↔ "action จริง (ขยาย/ปิดด่วน)" แบบ 2 ทิศทาง
--   1) other_income.fee_kind — ระบุว่ารายได้อื่นๆ นี้คือค่าธรรมเนียมสิทธิ์ไหน (เปลี่ยนวัน/ขยายงวด/ทั้งคู่/ปิดด่วน)
--   2) fee_waivers — บันทึกว่า admin "ยกเว้น" สิทธิ์นั้น (ไม่คิดค่าธรรมเนียม) เพื่อดับเตือน

-- ============================================================================
-- SECTION 1: other_income.fee_kind (nullable — แถวเก่า null = ข้าม ไม่ต้อง backfill)
-- ============================================================================

alter table public.other_income
  add column if not exists fee_kind text;

-- check constraint แยกจาก add column (idempotent — drop ก่อนสร้างใหม่)
alter table public.other_income
  drop constraint if exists other_income_fee_kind_chk;
alter table public.other_income
  add constraint other_income_fee_kind_chk
  check (fee_kind is null or fee_kind in ('due_day','months','both','settle'));

-- ============================================================================
-- SECTION 2: Table — fee_waivers (admin ยกเว้นค่าธรรมเนียมต่อสิทธิ์)
-- ============================================================================

create table if not exists public.fee_waivers (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references public.contracts(id) on delete cascade,
  fee_right    text not null check (fee_right in ('due_day','months','settle')),
  waived_by    text,            -- snapshot ชื่อ admin ผู้ยกเว้น
  note         text,
  created_at   timestamptz not null default now(),
  unique (contract_id, fee_right)  -- 1 สิทธิ์ยกเว้นได้ครั้งเดียวต่อสัญญา
);

create index if not exists fee_waivers_contract_idx
  on public.fee_waivers(contract_id);

-- ============================================================================
-- SECTION 3: RLS — SELECT staff+admin | INSERT/DELETE admin only (ไม่มี UPDATE)
--   mirror other_income (0054) แต่ INSERT จำกัด admin
-- ============================================================================

alter table public.fee_waivers enable row level security;

-- staff + admin: SELECT (staff อ่านเพื่อคำนวณ reconcile ใน ContractDetail)
drop policy if exists fee_waivers_read on public.fee_waivers;
create policy fee_waivers_read on public.fee_waivers
  for select to authenticated
  using (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
  );

-- admin only: INSERT
drop policy if exists fee_waivers_insert on public.fee_waivers;
create policy fee_waivers_insert on public.fee_waivers
  for insert to authenticated
  with check (is_admin());

-- admin only: DELETE
drop policy if exists fee_waivers_delete on public.fee_waivers;
create policy fee_waivers_delete on public.fee_waivers
  for delete to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 4: GRANTs
-- ============================================================================

-- service_role: full (0017 ครอบด้วย ALTER DEFAULT PRIVILEGES แล้ว แต่ใส่ชัดๆ)
grant select, insert, update, delete on public.fee_waivers to service_role;

-- authenticated: table-level ก่อน RLS ถึงจะตรวจ policy (ขาด → 42501 ก่อนถึง policy)
grant select, insert, delete on public.fee_waivers to authenticated;

-- ============================================================================
-- SECTION 5: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 5a) fee_kind column + constraint:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='other_income' AND column_name='fee_kind';
--   -- expected: fee_kind
--   INSERT ... fee_kind='xxx' → ต้อง fail (constraint), fee_kind='settle' → ผ่าน

-- 5b) fee_waivers table + service_role สิทธิ์:
--   SELECT has_table_privilege('service_role', 'public.fee_waivers', 'SELECT');  -- true
--   SELECT has_table_privilege('authenticated', 'public.fee_waivers', 'INSERT'); -- true

-- 5c) RLS enabled:
--   SELECT rowsecurity FROM pg_class WHERE relname='fee_waivers';  -- true

-- 5d) policies ครบ 3:
--   SELECT policyname FROM pg_policies WHERE tablename='fee_waivers' ORDER BY policyname;
--   -- expected: fee_waivers_delete, fee_waivers_insert, fee_waivers_read

-- 5e) index + unique:
--   SELECT indexname FROM pg_indexes WHERE tablename='fee_waivers' ORDER BY indexname;
--   -- expected: fee_waivers_contract_idx, fee_waivers_contract_id_fee_right_key, fee_waivers_pkey
