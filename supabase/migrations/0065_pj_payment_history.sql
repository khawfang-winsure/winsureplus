-- 0065: ตารางเก็บประวัติวันจ่ายจริงจาก PJ (รายงานผู้บริหาร — admin อ่านอย่างเดียว)
-- ดึงจาก pj-soft.net ทีละ batch; contract_id resolve ทีหลังด้วย UPDATE join source_inv

-- ============================================================================
-- SECTION 1: Table — pj_payment_history
-- 1 แถว = 1 งวด/1 ใบเสร็จจาก PJ พร้อมวันครบกำหนด + วันจ่ายจริง
-- days_late / is_late เป็น generated column อ้างเฉพาะ paid_date,due_date (ไม่อ้างกันเอง = ปลอดภัย)
-- ============================================================================

create table if not exists public.pj_payment_history (
  id            uuid        primary key default gen_random_uuid(),

  -- link กลับ contracts (null ถ้าแมตช์ไม่ได้)
  contract_id   uuid        references public.contracts(id) on delete set null,

  -- เลขสัญญา/อ้างอิงต้นฉบับจาก PJ
  source_inv    text        not null,

  -- ลำดับงวดจาก PJ (อาจ null)
  pj_seq        int,

  amount        numeric(12,2),
  due_date      date,
  paid_date     date,
  status        text,

  -- จำนวนวันที่จ่ายช้ากว่ากำหนด (0 ถ้าไม่ช้า หรือข้อมูลไม่ครบ)
  days_late     int generated always as (
    case
      when paid_date is not null and due_date is not null and paid_date > due_date
        then (paid_date - due_date)
      else 0
    end
  ) stored,

  -- จ่ายช้าหรือไม่ (true เมื่อจ่ายหลังวันครบกำหนด)
  is_late       boolean generated always as (
    paid_date is not null and due_date is not null and paid_date > due_date
  ) stored,

  imported_at   timestamptz not null default now()
);

-- ============================================================================
-- SECTION 2: Indexes
-- ============================================================================

create index if not exists pj_payment_history_contract_id_idx
  on public.pj_payment_history(contract_id);

create index if not exists pj_payment_history_source_inv_idx
  on public.pj_payment_history(source_inv);

create index if not exists pj_payment_history_is_late_idx
  on public.pj_payment_history(is_late);

create index if not exists pj_payment_history_paid_date_idx
  on public.pj_payment_history(paid_date);

-- ============================================================================
-- SECTION 3: RLS — admin อ่านอย่างเดียว (ข้อมูลรายงานผู้บริหาร)
-- service_role: full (สำหรับ import + UPDATE link contract_id)
-- ============================================================================

alter table public.pj_payment_history enable row level security;

-- admin: SELECT only (ไม่ให้แก้ผ่าน frontend — import ผ่าน service_role เท่านั้น)
drop policy if exists pj_payment_history_admin_read on public.pj_payment_history;
create policy pj_payment_history_admin_read on public.pj_payment_history
  for select to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 4: GRANTs
-- ============================================================================

-- service_role: full (import + UPDATE contract_id link; ไม่ผ่าน RLS)
grant select, insert, update, delete on public.pj_payment_history to service_role;

-- authenticated: SELECT เท่านั้น (RLS กันต่ออีกชั้นหนึ่ง — admin only)
grant select on public.pj_payment_history to authenticated;

-- ============================================================================
-- SECTION 5: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 5a) table มีอยู่ + service_role มีสิทธิ์ SELECT:
--   SELECT has_table_privilege('service_role', 'public.pj_payment_history', 'SELECT');
--   -- expected: true

-- 5b) service_role มีสิทธิ์ INSERT (สำหรับ import):
--   SELECT has_table_privilege('service_role', 'public.pj_payment_history', 'INSERT');
--   -- expected: true

-- 5c) RLS enabled:
--   SELECT rowsecurity FROM pg_class WHERE relname = 'pj_payment_history';
--   -- expected: true

-- 5d) policy มี 1 policy (admin_read):
--   SELECT policyname FROM pg_policies WHERE tablename = 'pj_payment_history';
--   -- expected: pj_payment_history_admin_read

-- 5e) indexes ครบ 5:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'pj_payment_history' ORDER BY indexname;
--   -- expected: pj_payment_history_contract_id_idx, pj_payment_history_is_late_idx,
--   --           pj_payment_history_paid_date_idx, pj_payment_history_pkey,
--   --           pj_payment_history_source_inv_idx
