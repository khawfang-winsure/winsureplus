-- 0077: ระบบ auto-sync PJ (Wave 1A) — 2 ตาราง log การรัน + กล่องรอตรวจ
-- ระบบนี้รันทุก 15 นาที (pg_cron) ดึงใบเสร็จจาก PJ → ลงงวดอัตโนมัติเฉพาะที่ตรงเป๊ะ
-- เคสที่ไม่ตรง (หลายงวด/จ่ายบางส่วน/หาสัญญาไม่เจอ/ยอดเพี้ยน) → เข้ากล่องรอตรวจให้คนยืนยัน
-- รัน Edge Function ด้วย service_role; หน้า admin อ่าน/ยืนยันผ่าน authenticated (RLS กันชั้นนอก)

-- ============================================================================
-- SECTION 1: Table — pj_sync_runs
-- log ของการรันแต่ละรอบ: debug + กันรอบทับ (mutex ผ่าน lock_owner) + แจ้งเตือน
-- ============================================================================

create table if not exists public.pj_sync_runs (
  id                  uuid        primary key default gen_random_uuid(),

  started_at          timestamptz not null default now(),   -- เวลาเริ่มรอบ
  finished_at         timestamptz,                          -- เวลาจบรอบ (null = ยังรันอยู่)

  status              text        not null default 'running', -- running/success/login_failed/error

  receipts_fetched    int         default 0,                 -- จำนวนใบเสร็จที่ดึงมาได้จาก PJ
  auto_applied_count  int         default 0,                 -- จำนวนงวดที่ลงอัตโนมัติ (EXACT)
  auto_applied_amount numeric     default 0,                 -- ยอดเงินรวมที่ลงอัตโนมัติ
  review_count        int         default 0,                 -- จำนวนเคสที่เข้ากล่องรอตรวจ

  error_detail        text,       -- รายละเอียด error (⚠️ ห้ามใส่รหัส/cookie/token — ผู้เขียน sync ต้องกรองก่อน insert)
  lock_owner          text        -- เจ้าของ lock (กันรอบทับ — รอบใหม่ skip ถ้ามี running < 10 นาที)
);

comment on table public.pj_sync_runs is 'log การรัน auto-sync PJ แต่ละรอบ — debug + กันรอบทับ + แจ้งเตือน';
comment on column public.pj_sync_runs.status is 'running/success/login_failed/error';
comment on column public.pj_sync_runs.error_detail is 'รายละเอียด error — ห้ามมีรหัส/cookie/token';
comment on column public.pj_sync_runs.lock_owner is 'mutex กันรอบทับ — รอบใหม่ skip ถ้ามี running < 10 นาที';

-- ============================================================================
-- SECTION 2: Table — pj_sync_review
-- กล่องรอตรวจ — เคสที่ไม่ EXACT ไม่ลงเอง รอ admin ยืนยัน
-- ============================================================================

create table if not exists public.pj_sync_review (
  id                  uuid        primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  run_id              uuid        references public.pj_sync_runs(id) on delete set null, -- รอบที่ตรวจพบ

  -- ข้อมูลใบเสร็จจาก PJ
  pj_invoice_no       text        not null,                 -- เลขใบเสร็จ PJ (= contracts.inv_no)
  pj_payment_type     text,                                 -- installment/penalty/down_payment/other
  pj_amount           numeric,                              -- ยอดเงินในใบเสร็จ
  pj_paid_date        date,                                 -- วันที่จ่ายจริงตามใบเสร็จ

  matched_contract_id uuid        references public.contracts(id) on delete set null, -- null = หาสัญญาไม่เจอ
  reason              text        not null,                 -- MULTI/PARTIAL/UNMATCHED/OTHER/AMOUNT_MISMATCH
  raw_json            jsonb,                                -- receipt ดิบ กันข้อมูลหาย

  status              text        not null default 'pending', -- pending/resolved/skipped
  resolved_by         text,                                 -- คนยืนยัน/ข้าม
  resolved_at         timestamptz,
  resolution_note     text                                  -- หมายเหตุตอนยืนยัน
);

comment on table public.pj_sync_review is 'กล่องรอตรวจ auto-sync PJ — เคสไม่ตรงเป๊ะ รอ admin ยืนยัน';
comment on column public.pj_sync_review.reason is 'MULTI/PARTIAL/UNMATCHED/OTHER/AMOUNT_MISMATCH';
comment on column public.pj_sync_review.matched_contract_id is 'null = หาสัญญาที่ตรงไม่เจอ';
comment on column public.pj_sync_review.raw_json is 'receipt ดิบจาก PJ — กันข้อมูลหายตอน reconcile';
comment on column public.pj_sync_review.status is 'pending/resolved/skipped';

-- ============================================================================
-- SECTION 3: Indexes
-- ============================================================================

create index if not exists pj_sync_runs_started_at_idx
  on public.pj_sync_runs(started_at desc);

create index if not exists pj_sync_review_status_idx
  on public.pj_sync_review(status);

create index if not exists pj_sync_review_matched_contract_id_idx
  on public.pj_sync_review(matched_contract_id);

-- ============================================================================
-- SECTION 4: RLS — admin only (ข้อมูลการเงิน/รายงาน)
-- service_role: full (Edge Function รัน sync + insert review)
-- authenticated: runs = SELECT, review = SELECT+UPDATE (admin ยืนยัน/ข้าม)
-- ============================================================================

alter table public.pj_sync_runs   enable row level security;
alter table public.pj_sync_review enable row level security;

-- pj_sync_runs: admin อ่านสถานะรอบเท่านั้น (insert/update ผ่าน service_role)
drop policy if exists pj_sync_runs_admin_read on public.pj_sync_runs;
create policy pj_sync_runs_admin_read on public.pj_sync_runs
  for select to authenticated
  using (is_admin());

-- pj_sync_review: admin อ่านกล่องรอตรวจ
drop policy if exists pj_sync_review_admin_read on public.pj_sync_review;
create policy pj_sync_review_admin_read on public.pj_sync_review
  for select to authenticated
  using (is_admin());

-- pj_sync_review: admin อัปเดต (ยืนยัน/ข้าม — set status/resolved_by/resolved_at/resolution_note)
drop policy if exists pj_sync_review_admin_update on public.pj_sync_review;
create policy pj_sync_review_admin_update on public.pj_sync_review
  for update to authenticated
  using (is_admin())
  with check (is_admin());

-- ============================================================================
-- SECTION 5: GRANTs
-- กับดัก 0017: sb_secret keys map เป็น Postgres role service_role ปกติ (ไม่ implicit BYPASS RLS)
-- ตารางใน public ได้ default privileges ของ 0017 อยู่แล้ว แต่ grant explicit ซ้ำเพื่อความชัวร์
-- ============================================================================

-- service_role: full (Edge Function รัน sync — insert runs/review, update runs, ลงงวดจริง)
grant select, insert, update, delete on public.pj_sync_runs   to service_role;
grant select, insert, update, delete on public.pj_sync_review to service_role;

-- authenticated: runs = SELECT (โชว์สถานะรอบ); review = SELECT+UPDATE (admin ยืนยัน — RLS กัน non-admin)
grant select on public.pj_sync_runs to authenticated;
grant select, update on public.pj_sync_review to authenticated;

-- ============================================================================
-- SECTION 6: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 6a) ตารางมีอยู่ + service_role มีสิทธิ์ครบ:
--   SELECT has_table_privilege('service_role', 'public.pj_sync_runs', 'INSERT');   -- true
--   SELECT has_table_privilege('service_role', 'public.pj_sync_review', 'INSERT'); -- true

-- 6b) authenticated สิทธิ์ถูกต้อง:
--   SELECT has_table_privilege('authenticated', 'public.pj_sync_review', 'UPDATE'); -- true
--   SELECT has_table_privilege('authenticated', 'public.pj_sync_runs', 'INSERT');   -- false (อ่านอย่างเดียว)

-- 6c) RLS enabled ทั้ง 2:
--   SELECT relname, rowsecurity FROM pg_class WHERE relname IN ('pj_sync_runs','pj_sync_review');
--   -- expected: rowsecurity = true ทั้งคู่

-- 6d) policies ครบ 3:
--   SELECT tablename, policyname FROM pg_policies
--   WHERE tablename IN ('pj_sync_runs','pj_sync_review') ORDER BY tablename, policyname;
--   -- expected: pj_sync_review_admin_read, pj_sync_review_admin_update, pj_sync_runs_admin_read

-- 6e) indexes ครบ:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename IN ('pj_sync_runs','pj_sync_review') ORDER BY indexname;
--   -- expected: pj_sync_review_matched_contract_id_idx, pj_sync_review_pkey,
--   --           pj_sync_review_status_idx, pj_sync_runs_pkey, pj_sync_runs_started_at_idx
