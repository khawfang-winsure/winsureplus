-- 0064: ตารางเก็บเคสติดตามหนี้จาก DEBTFLOW (รายงานผู้บริหาร — admin อ่านอย่างเดียว)

-- ============================================================================
-- SECTION 1: Table — debtflow_cases
-- import ทีละ batch จาก CSV; contract_id resolve ทีหลังด้วย UPDATE join inv_no
-- ============================================================================

create table if not exists public.debtflow_cases (
  id                  uuid        primary key default gen_random_uuid(),

  -- link กลับ contracts (null ถ้าแมตช์ไม่ได้)
  contract_id         uuid        references public.contracts(id) on delete set null,

  -- เลขสัญญาต้นฉบับจาก DEBTFLOW (cleaned: ตัด comma/NBSP/ช่องว่าง)
  source_inv          text        not null,

  -- ข้อมูลลูกค้า (snapshot ณ วันที่ import)
  customer_name       text,
  due_date            date,
  days_late           int,
  grade               text,
  primary_phone       text,
  call_status         text,
  phone_alt1          text,
  phone_alt2          text,
  device_status       text,
  conversation_note   text,
  promise_date        date,
  assigned_employee   text,
  payment_status      text,
  installment_amount  numeric(12,2),
  cumulative_paid     numeric(12,2),
  date_added          date,
  last_update         timestamptz,

  imported_at         timestamptz not null default now()
);

-- ============================================================================
-- SECTION 2: Indexes
-- ============================================================================

create index if not exists debtflow_cases_source_inv_idx
  on public.debtflow_cases(source_inv);

create index if not exists debtflow_cases_contract_id_idx
  on public.debtflow_cases(contract_id);

create index if not exists debtflow_cases_assigned_employee_idx
  on public.debtflow_cases(assigned_employee);

create index if not exists debtflow_cases_payment_status_idx
  on public.debtflow_cases(payment_status);

-- ============================================================================
-- SECTION 3: RLS — admin อ่านอย่างเดียว (ข้อมูลรายงานผู้บริหาร)
-- service_role: full (สำหรับ import + UPDATE link contract_id)
-- ============================================================================

alter table public.debtflow_cases enable row level security;

-- admin: SELECT only (ไม่ให้แก้ผ่าน frontend — import ผ่าน service_role เท่านั้น)
drop policy if exists debtflow_cases_admin_read on public.debtflow_cases;
create policy debtflow_cases_admin_read on public.debtflow_cases
  for select to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 4: GRANTs
-- ============================================================================

-- service_role: full (import + UPDATE contract_id link; ไม่ผ่าน RLS)
grant select, insert, update, delete on public.debtflow_cases to service_role;

-- authenticated: SELECT เท่านั้น (RLS กันต่ออีกชั้นหนึ่ง — admin only)
grant select on public.debtflow_cases to authenticated;

-- ============================================================================
-- SECTION 5: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 5a) table มีอยู่ + service_role มีสิทธิ์ SELECT:
--   SELECT has_table_privilege('service_role', 'public.debtflow_cases', 'SELECT');
--   -- expected: true

-- 5b) service_role มีสิทธิ์ INSERT (สำหรับ import):
--   SELECT has_table_privilege('service_role', 'public.debtflow_cases', 'INSERT');
--   -- expected: true

-- 5c) RLS enabled:
--   SELECT rowsecurity FROM pg_class WHERE relname = 'debtflow_cases';
--   -- expected: true

-- 5d) policy มี 1 policy (admin_read):
--   SELECT policyname FROM pg_policies WHERE tablename = 'debtflow_cases';
--   -- expected: debtflow_cases_admin_read

-- 5e) indexes ครบ 4:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'debtflow_cases' ORDER BY indexname;
--   -- expected: debtflow_cases_assigned_employee_idx, debtflow_cases_contract_id_idx,
--   --           debtflow_cases_payment_status_idx, debtflow_cases_pkey, debtflow_cases_source_inv_idx
