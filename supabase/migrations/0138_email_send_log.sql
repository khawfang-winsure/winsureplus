-- 0138: ตาราง email_send_log — ประวัติส่งอีเมลเอกสารสัญญาให้บริษัท (send-company-email Edge Function)
-- เป้าหมาย: เก็บหลักฐานว่าส่งเมลไปแล้วเมื่อไหร่/ถึงใคร/แนบกี่ไฟล์/สำเร็จหรือพัง — โชว์ที่หน้า ContractDetail
-- เขียนได้ทาง service_role เท่านั้น (Edge Function) — authenticated อ่านได้อย่างเดียว กันแก้ย้อนหลัง
-- Additive ทั้งหมด

create table if not exists public.email_send_log (
  id                    uuid primary key default gen_random_uuid(),
  contract_id           uuid not null references public.contracts (id) on delete cascade,
  to_addr               text not null,
  subject               text not null,
  attachment_count      int not null default 0,
  total_bytes           bigint not null default 0,
  provider_message_id   text,
  status                text not null check (status in ('sent', 'failed')),
  error                 text,
  sent_by               uuid references auth.users (id) on delete set null,
  sent_at               timestamptz not null default now()
);

create index if not exists email_send_log_contract_idx
  on public.email_send_log (contract_id);

comment on table public.email_send_log is
  'ประวัติส่งอีเมลเอกสารสัญญาให้บริษัท (ทั้งสำเร็จและพัง) — เขียนได้ทาง service_role เท่านั้นจาก send-company-email Edge Function ห้ามแก้ย้อนหลัง';

alter table public.email_send_log enable row level security;

drop policy if exists email_send_log_select on public.email_send_log;
create policy email_send_log_select
  on public.email_send_log
  for select to authenticated
  using (is_admin() or is_staff() or is_accounting());

-- ไม่มี INSERT/UPDATE/DELETE policy สำหรับ authenticated เลย — เขียนได้ทาง service_role
-- (Edge Function ใช้ SUPABASE_SERVICE_ROLE_KEY) เท่านั้น กันแก้ไข/ปลอมประวัติย้อนหลัง

grant select on public.email_send_log to authenticated;
grant select, insert, update, delete on public.email_send_log to service_role;

-- ============================================================================
-- Smoke SQL (รันมือหลัง apply เพื่อ verify — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================
-- 1) service_role เขียนได้ (Edge Function จะพังถ้าไม่ผ่าน):
-- SELECT has_table_privilege('service_role', 'public.email_send_log', 'INSERT');
--
-- 2) authenticated (staff/admin/accounting) อ่านได้, freelancer อ่านไม่ได้:
-- SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'email_send_log';
--
-- 3) ไม่มี policy insert/update/delete สำหรับ authenticated (ตั้งใจ — เขียนทาง service_role เท่านั้น):
-- SELECT count(*) FROM pg_policies WHERE tablename = 'email_send_log' AND cmd IN ('INSERT','UPDATE','DELETE');
-- expected: 0
