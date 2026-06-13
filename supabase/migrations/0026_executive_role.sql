-- 0026: เพิ่ม Executive role สำหรับผู้บริหาร (เห็นแค่ Dashboard ภาพรวม /exec)
-- Locked by Pete + Cream 2026-06-13
-- Strategy: Option A — additive SELECT-only policies (Postgres ORs permissive policies)
--   executive = trusted insider; frontend redirect คือ UX gate;
--   RLS layer ให้ executive อ่าน raw tables ได้เหมือน staff (เพื่อให้ /exec ทำงานได้)
-- Tables needing additive policy (denied by 0018 explicit role checks):
--   contracts, installments, shops, payment_log, contract_extensions, device_returns, profiles
-- Tables already open to authenticated (no change needed):
--   app_settings (using(true) from 0001), options (using(true) from 0001)
-- IMPORTANT: v_contract_status uses security_invoker=on — inherits executive SELECT on contracts
--   automatically once contracts_executive_read policy is active.

-- ============================================================================
-- SECTION 1: Widen profiles_role_check to include 'executive'
-- Drop + re-add (safe: no existing rows with 'executive')
-- Preserves: admin, staff, freelancer from 0018
-- ============================================================================

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'staff', 'freelancer', 'executive'));

-- ============================================================================
-- SECTION 2: Helper function is_executive()
-- Pattern: matches is_admin() / is_freelancer() / is_staff() exactly
-- active = true check: deactivated executive must lose read access immediately
-- SECURITY DEFINER: avoids infinite recursion (policy → subquery profiles → policy → 42P17)
-- set search_path = public: prevents search_path injection
-- ============================================================================

create or replace function public.is_executive()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'executive'
      and active = true
  );
$$;

grant execute on function public.is_executive() to authenticated, service_role;

-- ============================================================================
-- SECTION 3: Additive SELECT-only policies for tables denied to executive by 0018
--
-- Technique: Postgres ORs permissive policies on the same table.
-- Adding a new FOR SELECT policy does NOT modify the existing staff/freelancer
-- policies — they remain unchanged. Executive reads via the new policy;
-- other roles read via their existing policies. Zero regression risk.
--
-- Trade-off accepted by Cream (2026-06-13):
--   executive sees raw rows including national_id; frontend redirect hides the pages.
--   This is v1 "trusted insider" bargain — accepted explicitly.
-- ============================================================================

-- ----- 3a) contracts -----
-- 0018 §5a: contracts_read = admin OR staff OR (freelancer + grade)
-- executive needs SELECT to power /exec dashboard aggregates
drop policy if exists contracts_executive_read on public.contracts;
create policy contracts_executive_read on public.contracts
  for select to authenticated
  using (is_executive());

-- ----- 3b) installments -----
-- 0018 §5b: installments_read = admin OR staff OR (freelancer subquery)
drop policy if exists installments_executive_read on public.installments;
create policy installments_executive_read on public.installments
  for select to authenticated
  using (is_executive());

-- ----- 3c) shops -----
-- 0018 §5h: shops_read = admin OR staff only (freelancer uses shops_basic view)
-- executive needs shop names for /exec aggregates
drop policy if exists shops_executive_read on public.shops;
create policy shops_executive_read on public.shops
  for select to authenticated
  using (is_executive());

-- ----- 3d) payment_log -----
-- 0018 §5e: payment_log_read = admin OR staff
-- executive needs this for cashflow tab in /exec
drop policy if exists payment_log_executive_read on public.payment_log;
create policy payment_log_executive_read on public.payment_log
  for select to authenticated
  using (is_executive());

-- ----- 3e) contract_extensions -----
-- 0018 §5f: contract_extensions_read = admin OR staff
-- executive needs this for getAllExtensions() used in /exec
drop policy if exists contract_extensions_executive_read on public.contract_extensions;
create policy contract_extensions_executive_read on public.contract_extensions
  for select to authenticated
  using (is_executive());

-- ----- 3f) device_returns -----
-- 0018 §5c: device_returns_staff = admin OR staff (FOR ALL — covers SELECT)
-- executive needs this for getReturns() used in /exec
drop policy if exists device_returns_executive_read on public.device_returns;
create policy device_returns_executive_read on public.device_returns
  for select to authenticated
  using (is_executive());

-- ----- 3g) profiles -----
-- 0001: profiles_read = id = auth.uid() OR is_admin()
-- 0022: profiles_read_staff_view adds: is_staff() AND role='freelancer'
-- getEmployees() in /exec reads profiles for staff names in briefing/attribution
-- executive needs to read all profiles (same scope as admin) for /exec employee lists
drop policy if exists profiles_executive_read on public.profiles;
create policy profiles_executive_read on public.profiles
  for select to authenticated
  using (is_executive());

-- NOTE: v_contract_status — no policy change needed.
--   security_invoker=on (0018 §7) means the view runs as the caller.
--   With contracts_executive_read above, executive can SELECT contracts → view works.
--   Same for follow_ups_read (0018 §6): executive is not expected to read /queue,
--   but if frontend ever routes there, they'll be denied by the existing policy (safe).

-- ============================================================================
-- SECTION 4: GRANT execute — already done in Section 2 above.
-- No new tables created, so no additional GRANT needed.
-- (0017 ALTER DEFAULT PRIVILEGES covers future tables; no new tables here)
-- ============================================================================

-- ============================================================================
-- SECTION 5: Smoke SQL (run manually after apply to verify)
-- ============================================================================
-- 1) Verify constraint widened
-- SELECT pg_get_constraintdef(c.oid)
--   FROM pg_constraint c
--   JOIN pg_class r ON r.oid = c.conrelid
--   WHERE c.conname = 'profiles_role_check' AND r.relname = 'profiles';
-- expected: contains 'executive'
--
-- 2) Test constraint accepts 'executive' (run in transaction, rollback)
-- BEGIN;
-- INSERT INTO public.profiles (id, full_name, role)
--   VALUES (gen_random_uuid(), 'Test Executive', 'executive');
-- -- expected: INSERT succeeds (no constraint violation)
-- ROLLBACK;
--
-- 3) Verify is_executive() function exists and returns false for non-executive caller
-- SELECT public.is_executive();
-- expected: false (caller = service_role or non-executive user)
--
-- 4) Verify SELECT policies exist on each table
-- SELECT tablename, policyname, cmd
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND policyname LIKE '%executive%'
--   ORDER BY tablename;
-- expected: 7 rows (contracts, installments, shops, payment_log,
--           contract_extensions, device_returns, profiles)
--
-- 5) Verify is_executive() has active=true guard
-- SELECT prosrc FROM pg_proc WHERE proname = 'is_executive';
-- expected: body contains 'active = true'
