-- 0161: ตารางประวัติ "เลื่อนวันครบกำหนดอัตโนมัติ" ของ pj-sync (อนุมัติคุณเตย 21 ก.ย. 2026)
--
-- บริบท: ร้านเปลี่ยนวันชำระในระบบ PJ (ลงเป็นใบเสร็จค่าธรรมเนียม "อื่นๆ" เช่น 500 บาท) แต่วันครบกำหนด
-- ของเรา (installments.due_date / contracts.due_day) ไม่ขยับตาม ทำให้ทวงหนี้ผิดวัน/คิดค่าปรับผิด —
-- วันนี้ครีมแก้มือไปแล้ว 8 สัญญา (S00006PNQ033, S00015PNQ060, S00017PNQ128, S00017PNQ186,
-- S00018PNQ052, S00018PNQ233, S00023PNQ002, S00032PNQ062) งานนี้ทำให้ pj-sync ตรวจจับ "เคสง่าย"
-- (ยอดค่างวด/จำนวนงวดเท่าเดิม ต่างแค่วัน ไม่มีงวดไหนเลยกำหนดทันทีหลังเลื่อน) แล้วเลื่อนให้อัตโนมัติ —
-- เคสซับซ้อนยังคงเข้ากล่องรอตรวจ (pj_sync_review, reason='PLAN_CHANGE_REVIEW') ให้คนตัดสินใจเหมือนเดิม
--
-- ตารางนี้เก็บ "ประวัติทุกครั้ง" ที่ auto-shift เกิดขึ้นจริง (mode='live') เพื่อย้อนกลับได้เสมอ — เก็บ
-- snapshot ก่อน/หลังของทุกงวดที่ถูกแก้ (jsonb) ไม่ใช่แค่ due_day เดี่ยวๆ เผื่อ investigate ย้อนหลัง
--
-- Additive/idempotent — create table if not exists, ไม่แตะตารางอื่นเลย
-- ตารางอยู่ใน public schema → ได้ default privileges ของ service_role จาก migration 0017 อัตโนมัติ
-- (grant ซ้ำแบบ explicit ไว้ด้วยกันเหนียว ตาม convention เดิมของไฟล์อื่นๆ ในโปรเจกต์)

-- ============================================================================
-- SECTION 1: Table — pj_auto_dueday_log
-- ============================================================================

create table if not exists public.pj_auto_dueday_log (
  id                    uuid        primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),

  contract_id           uuid        references public.contracts(id) on delete set null,
  pj_invoice_no         text        not null,
  pj_paid_date          date,                     -- วันที่จ่ายของใบเสร็จค่าธรรมเนียม "อื่นๆ" ต้นเหตุ

  old_due_day           int,                       -- contracts.due_day ก่อนแก้ (null ได้ถ้าไม่เคยตั้ง)
  new_due_day           int         not null check (new_due_day between 1 and 31),

  installments_before   jsonb       not null,      -- [{installment_id, installment_no, due_date}] ก่อนแก้
  installments_after    jsonb       not null,      -- [{installment_id, installment_no, due_date}] หลังแก้

  other_income_id       uuid        references public.other_income(id) on delete set null, -- แถวค่าธรรมเนียมคู่กัน (ถ้าลงสำเร็จ)
  run_id                uuid        references public.pj_sync_runs(id) on delete set null,

  mode                  text        not null default 'live' check (mode in ('live', 'dry_run')),
  created_by            text        not null default 'PJ Auto-Sync'
);

comment on table public.pj_auto_dueday_log is
  'ประวัติ "เลื่อนวันครบกำหนดอัตโนมัติ" ของ pj-sync เมื่อ PJ เปลี่ยนวันชำระ (ใบค่าธรรมเนียมอื่นๆ) — เก็บ snapshot ก่อน/หลังทุกงวดที่แก้ ย้อนกลับได้เสมอ';
comment on column public.pj_auto_dueday_log.installments_before is 'snapshot งวดที่ถูกแก้ ก่อนแก้ — [{installment_id, installment_no, due_date}]';
comment on column public.pj_auto_dueday_log.installments_after is 'snapshot งวดที่ถูกแก้ หลังแก้ — [{installment_id, installment_no, due_date}]';
comment on column public.pj_auto_dueday_log.mode is 'live = แก้ข้อมูลจริง / dry_run ไม่ได้ใช้ในตารางนี้จริง (dry-run log ไปอยู่ pj_sync_review แทน) — เผื่ออนาคต';

create index if not exists pj_auto_dueday_log_contract_idx
  on public.pj_auto_dueday_log(contract_id, created_at desc);

create index if not exists pj_auto_dueday_log_run_idx
  on public.pj_auto_dueday_log(run_id);

-- ============================================================================
-- SECTION 2: RLS — admin อ่านได้อย่างเดียว (ข้อมูลตรวจสอบ/audit เหมือน pj_sync_runs)
-- service_role: full (Edge Function pj-sync เขียนตอน mode=on เท่านั้น)
-- authenticated (รวม staff): ไม่มีสิทธิ์เขียนเลย — ตารางนี้เป็น audit log ห้ามแก้ไข
-- ============================================================================

alter table public.pj_auto_dueday_log enable row level security;

drop policy if exists pj_auto_dueday_log_admin_read on public.pj_auto_dueday_log;
create policy pj_auto_dueday_log_admin_read on public.pj_auto_dueday_log
  for select to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 3: GRANTs
-- ============================================================================

-- service_role: full (Edge Function เขียน insert เท่านั้นในทางปฏิบัติ — ให้ครบตาม convention เดิม)
grant select, insert, update, delete on public.pj_auto_dueday_log to service_role;

-- authenticated: SELECT เท่านั้น (RLS จำกัดเฉพาะ admin อ่านได้ — staff/freelancer ไม่เห็นตารางนี้)
grant select on public.pj_auto_dueday_log to authenticated;

-- ============================================================================
-- SECTION 4: Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 4a) ตารางมีอยู่ + service_role มีสิทธิ์ครบ:
--   SELECT has_table_privilege('service_role', 'public.pj_auto_dueday_log', 'INSERT'); -- expected: true

-- 4b) authenticated มีแค่ SELECT (ไม่มี INSERT/UPDATE/DELETE):
--   SELECT has_table_privilege('authenticated', 'public.pj_auto_dueday_log', 'SELECT'); -- true
--   SELECT has_table_privilege('authenticated', 'public.pj_auto_dueday_log', 'INSERT'); -- false

-- 4c) RLS enabled:
--   SELECT rowsecurity FROM pg_class WHERE relname = 'pj_auto_dueday_log'; -- expected: true

-- 4d) policy มีแค่ 1 (admin read):
--   SELECT policyname FROM pg_policies WHERE tablename = 'pj_auto_dueday_log';
--   -- expected: pj_auto_dueday_log_admin_read

-- 4e) index ครบ:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'pj_auto_dueday_log' ORDER BY indexname;
--   -- expected: pj_auto_dueday_log_contract_idx, pj_auto_dueday_log_pkey, pj_auto_dueday_log_run_idx
