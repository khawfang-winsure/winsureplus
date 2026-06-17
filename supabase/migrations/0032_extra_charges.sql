-- 0032: ตารางค่าใช้จ่ายเพิ่มเติม (extra_charges) นอกเหนือจากค่างวดปกติ

-- ============================================================================
-- SECTION 1: Table — extra_charges
-- ============================================================================

create table if not exists public.extra_charges (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  amount      numeric(12,2) not null check (amount >= 0),
  reason      text not null,
  created_at  timestamptz not null default now(),
  created_by  text  -- denormalized name snapshot (ไม่ต้อง JOIN profiles ตอน read)
);

-- index หลัก: ค้นตาม contract + เวลา (UI list เรียงล่าสุดก่อน)
create index if not exists extra_charges_contract_idx
  on public.extra_charges(contract_id, created_at desc);

-- ============================================================================
-- SECTION 2: RLS
-- ============================================================================

alter table public.extra_charges enable row level security;

-- staff + admin: SELECT
drop policy if exists extra_charges_read on public.extra_charges;
create policy extra_charges_read on public.extra_charges
  for select to authenticated
  using (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
  );

-- staff + admin: INSERT
drop policy if exists extra_charges_insert on public.extra_charges;
create policy extra_charges_insert on public.extra_charges
  for insert to authenticated
  with check (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
  );

-- admin only: DELETE
drop policy if exists extra_charges_delete on public.extra_charges;
create policy extra_charges_delete on public.extra_charges
  for delete to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 3: GRANTs
-- ============================================================================

-- service_role: full (Edge Functions + cron; explicit belt-and-suspenders)
grant select, insert, update, delete on public.extra_charges to service_role;

-- authenticated: SELECT + INSERT + DELETE (RLS limits per-policy above)
grant select, insert, delete on public.extra_charges to authenticated;

-- ============================================================================
-- SECTION 4: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 4a) table มีอยู่:
--   SELECT has_table_privilege('service_role', 'public.extra_charges', 'SELECT');
--   -- expected: true

-- 4b) RLS enabled:
--   SELECT rowsecurity FROM pg_class WHERE relname = 'extra_charges';
--   -- expected: true

-- 4c) policies ครบ:
--   SELECT policyname FROM pg_policies WHERE tablename = 'extra_charges' ORDER BY policyname;
--   -- expected: extra_charges_delete, extra_charges_insert, extra_charges_read
