-- 0054: ตารางรายได้อื่นๆ (other_income) นอกเหนือจากค่างวด เช่น ค่าเปลี่ยนวันชำระ

-- ============================================================================
-- SECTION 1: Table — other_income
-- ============================================================================

create table if not exists public.other_income (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid references public.contracts(id) on delete set null, -- nullable: รายได้ไม่ผูกสัญญาก็ได้
  amount       numeric(12,2) not null check (amount >= 0),
  category     text not null,   -- free-text v1 เช่น 'ค่าเปลี่ยนวันที่ชำระ'
  note         text,            -- รายละเอียดเพิ่มเติม (optional)
  received_at  date not null,   -- วันรับเงินจริง — ใช้ bucket cashflow
  recorded_by  text,            -- snapshot ชื่อผู้บันทึก (เหมือน extra_charges.created_by)
  created_at   timestamptz not null default now()
);

-- index หลัก: ค้นตาม contract + วันรับเงิน
create index if not exists other_income_contract_idx
  on public.other_income(contract_id, received_at desc);

-- index เพิ่ม: ค้นตามช่วงวัน (สำหรับ cashflow bucket)
create index if not exists other_income_received_at_idx
  on public.other_income(received_at desc);

-- ============================================================================
-- SECTION 2: RLS — mirror extra_charges (migration 0032)
-- staff + admin: SELECT + INSERT | admin only: DELETE
-- ============================================================================

alter table public.other_income enable row level security;

-- staff + admin: SELECT
drop policy if exists other_income_read on public.other_income;
create policy other_income_read on public.other_income
  for select to authenticated
  using (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
  );

-- staff + admin: INSERT
drop policy if exists other_income_insert on public.other_income;
create policy other_income_insert on public.other_income
  for insert to authenticated
  with check (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
  );

-- admin only: DELETE (staff ไม่มีสิทธิ์ลบ — deleteOtherIncome จะ RLS-fail สำหรับ staff)
drop policy if exists other_income_delete on public.other_income;
create policy other_income_delete on public.other_income
  for delete to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 3: GRANTs
-- ============================================================================

-- service_role: full (Edge Functions + cron; explicit belt-and-suspenders)
-- หมายเหตุ: 0017 ALTER DEFAULT PRIVILEGES ครอบ service_role แล้ว แต่ใส่ชัดๆ ไว้ด้วย
grant select, insert, update, delete on public.other_income to service_role;

-- authenticated: SELECT + INSERT + DELETE (RLS จำกัดต่อ policy ด้านบน)
-- ต้องมี table-level privilege ก่อน RLS ถึงจะตรวจ — ขาดตัวนี้ staff เจอ 42501 ก่อนถึง policy
grant select, insert, delete on public.other_income to authenticated;

-- ============================================================================
-- SECTION 4: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 4a) table มีอยู่ + service_role มีสิทธิ์:
--   SELECT has_table_privilege('service_role', 'public.other_income', 'SELECT');
--   -- expected: true

-- 4b) authenticated มีสิทธิ์ (สำคัญ — RLS check บนนี้):
--   SELECT has_table_privilege('authenticated', 'public.other_income', 'SELECT');
--   -- expected: true

-- 4c) RLS enabled:
--   SELECT rowsecurity FROM pg_class WHERE relname = 'other_income';
--   -- expected: true

-- 4d) policies ครบ 3:
--   SELECT policyname FROM pg_policies WHERE tablename = 'other_income' ORDER BY policyname;
--   -- expected: other_income_delete, other_income_insert, other_income_read

-- 4e) index มีอยู่:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'other_income' ORDER BY indexname;
--   -- expected: other_income_contract_idx, other_income_pkey, other_income_received_at_idx
