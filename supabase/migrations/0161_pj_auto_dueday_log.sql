-- 0161: ตารางประวัติ + RPC atomic "เลื่อนวันครบกำหนดอัตโนมัติ" ของ pj-sync (อนุมัติคุณเตย 21 ก.ย. 2026;
-- รอบแก้ที่ 2 หลังติ๊กรีวิว — เพิ่ม RPC เดียวทำทุกอย่างแบบ atomic แทนหลาย UPDATE แยกจาก Edge Function)
--
-- บริบท: ร้านเปลี่ยนวันชำระในระบบ PJ (ลงเป็นใบเสร็จค่าธรรมเนียม "อื่นๆ" เช่น 500 บาท) แต่วันครบกำหนด
-- ของเรา (installments.due_date / contracts.due_day) ไม่ขยับตาม ทำให้ทวงหนี้ผิดวัน/คิดค่าปรับผิด —
-- วันนี้ครีมแก้มือไปแล้ว 8 สัญญา (S00006PNQ033, S00015PNQ060, S00017PNQ128, S00017PNQ186,
-- S00018PNQ052, S00018PNQ233, S00023PNQ002, S00032PNQ062) งานนี้ทำให้ pj-sync ตรวจจับ "เคสง่าย"
-- (ยอดค่างวด/จำนวนงวดเท่าเดิม ต่างแค่วัน ไม่มีงวดไหนเลยกำหนดทันทีหลังเลื่อน) แล้วเลื่อนให้อัตโนมัติ —
-- เคสซับซ้อนยังคงเข้ากล่องรอตรวจ (pj_sync_review, reason='PLAN_CHANGE_REVIEW') ให้คนตัดสินใจเหมือนเดิม
--
-- ตารางนี้เก็บ "ประวัติทุกครั้ง" ที่ auto-shift ถูกพยายามทำ (ทั้งสำเร็จ status='success' และล้มเหลว
-- status='failed' — ติ๊ก RED #6) เพื่อย้อนกลับ/ตรวจสอบได้เสมอ — เก็บ snapshot ก่อน/หลังของทุกงวดที่
-- ถูกแก้ (jsonb) ไม่ใช่แค่ due_day เดี่ยวๆ
--
-- RPC pj_auto_dueday_shift (ติ๊ก RED #4) รวมการอัปเดตหลายงวด + contracts.due_day + other_income +
-- pj_auto_dueday_log ไว้ทรานแซกชันเดียวกัน (atomic — ถ้า raise exception กลางทาง rollback หมดทั้งก้อน
-- ไม่มีทางแก้ due_date งวดหนึ่งสำเร็จแต่ due_day/ค่าธรรมเนียมหาย) + เช็คซ้ำเองข้างในว่างวดที่จะแก้ยัง
-- paid_amount=0 และ new_due_date > current_date จริง (กัน race condition ระหว่างตอน Edge Function
-- ตัดสินใจกับตอน RPC รันจริง — เช่น ลูกค้าจ่ายเงินงวดนั้นพอดีในช่วงเสี้ยววินาทีที่ผ่านไป)
--
-- Additive/idempotent — create table if not exists / add column if not exists / create or replace
-- function ทั้งหมด ไม่แตะตาราง/ข้อมูลอื่นเลย
-- ตารางอยู่ใน public schema → ได้ default privileges ของ service_role จาก migration 0017 อัตโนมัติ
-- (grant ซ้ำแบบ explicit ไว้ด้วยกันเหนียว ตาม convention เดิมของไฟล์อื่นๆ ในโปรเจกต์) — ฟังก์ชัน RPC
-- เป็นสิทธิ์พิเศษกว่าตารางทั่วไป จึง revoke จาก public/anon/authenticated แล้ว grant execute ให้
-- service_role อย่างเดียว (ติ๊ก RED #4 — ห้ามใครอื่นเรียกได้เลยนอกจาก Edge Function)

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
  installments_after    jsonb       not null,      -- [{installment_id, installment_no, due_date}] หลังแก้ (ตั้งใจ = ก่อนแก้ ถ้า status='failed')

  other_income_id       uuid        references public.other_income(id) on delete set null, -- แถวค่าธรรมเนียมคู่กัน (ถ้าลงสำเร็จ)
  run_id                uuid        references public.pj_sync_runs(id) on delete set null,

  mode                  text        not null default 'live' check (mode in ('live', 'dry_run')),
  status                text        not null default 'success' check (status in ('success', 'failed')),
  error                 text,                      -- ข้อความ error ของ RPC (เฉพาะ status='failed')
  created_by            text        not null default 'PJ Auto-Sync'
);

comment on table public.pj_auto_dueday_log is
  'ประวัติ "เลื่อนวันครบกำหนดอัตโนมัติ" ของ pj-sync เมื่อ PJ เปลี่ยนวันชำระ (ใบค่าธรรมเนียมอื่นๆ) — เก็บ snapshot ก่อน/หลังทุกงวดที่แก้ (ทั้งสำเร็จ/ล้มเหลว) ย้อนกลับได้เสมอ';
comment on column public.pj_auto_dueday_log.installments_before is 'snapshot งวดที่ถูกแก้ ก่อนแก้ — [{installment_id, installment_no, due_date}]';
comment on column public.pj_auto_dueday_log.installments_after is 'snapshot งวดที่ถูกแก้ หลังแก้ — [{installment_id, installment_no, due_date}] (เท่ากับก่อนแก้ถ้า status=failed เพราะไม่ได้แก้จริง)';
comment on column public.pj_auto_dueday_log.mode is 'live = แก้ข้อมูลจริง (ผ่าน RPC) / dry_run ไม่ได้ใช้ในตารางนี้จริง (dry-run log ไปอยู่ pj_sync_review แทน) — เผื่ออนาคต';
comment on column public.pj_auto_dueday_log.status is 'success = RPC ทำสำเร็จทั้งก้อน / failed = RPC raise exception (rollback หมดแล้ว) — Edge Function insert แถวนี้แยกเองนอก RPC';
comment on column public.pj_auto_dueday_log.error is 'ข้อความ error จาก RPC — เฉพาะ status=failed';

-- (idempotent เผื่อรันซ้ำหลังตารางมีอยู่แล้วจากรอบแรกที่ยังไม่มี status/error)
alter table public.pj_auto_dueday_log
  add column if not exists status text not null default 'success',
  add column if not exists error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pj_auto_dueday_log'::regclass
      and conname = 'pj_auto_dueday_log_status_check'
  ) then
    alter table public.pj_auto_dueday_log
      add constraint pj_auto_dueday_log_status_check check (status in ('success', 'failed'));
  end if;
end $$;

create index if not exists pj_auto_dueday_log_contract_idx
  on public.pj_auto_dueday_log(contract_id, created_at desc);

create index if not exists pj_auto_dueday_log_run_idx
  on public.pj_auto_dueday_log(run_id);

-- ============================================================================
-- SECTION 2: RLS — admin อ่านได้อย่างเดียว (ข้อมูลตรวจสอบ/audit เหมือน pj_sync_runs)
-- service_role: full (Edge Function pj-sync เขียนตอน mode=on เท่านั้น — ทั้งผ่าน RPC และ insert ตรง
-- ตอน status='failed')
-- authenticated (รวม staff): ไม่มีสิทธิ์เขียนเลย — ตารางนี้เป็น audit log ห้ามแก้ไข
-- ============================================================================

alter table public.pj_auto_dueday_log enable row level security;

drop policy if exists pj_auto_dueday_log_admin_read on public.pj_auto_dueday_log;
create policy pj_auto_dueday_log_admin_read on public.pj_auto_dueday_log
  for select to authenticated
  using (is_admin());

-- ============================================================================
-- SECTION 3: GRANTs (ตาราง)
-- ============================================================================

-- service_role: full (Edge Function เขียน insert เท่านั้นในทางปฏิบัติ — ให้ครบตาม convention เดิม)
grant select, insert, update, delete on public.pj_auto_dueday_log to service_role;

-- authenticated: SELECT เท่านั้น (RLS จำกัดเฉพาะ admin อ่านได้ — staff/freelancer ไม่เห็นตารางนี้)
grant select on public.pj_auto_dueday_log to authenticated;

-- ============================================================================
-- SECTION 4: RPC — pj_auto_dueday_shift (atomic: installments หลายงวด + contracts.due_day +
-- other_income + pj_auto_dueday_log ทั้งหมดในทรานแซกชันเดียว)
-- ============================================================================
--
-- p_installment_updates shape: jsonb array ของ {"installment_id": "<uuid>", "new_due_date": "YYYY-MM-DD"}
-- คืนค่า id ของแถว pj_auto_dueday_log ที่สร้าง (status='success' เสมอ — ถ้าจะล้มเหลวฟังก์ชันนี้ raise
-- exception ออกไปแทน ไม่มีทาง return แถว status='failed' ได้เอง เพราะ transaction rollback ไปแล้ว
-- — Edge Function เป็นคน insert แถว status='failed' แยกต่างหากเองหลังจับ error จาก RPC นี้)
--
-- SECURITY DEFINER: ต้องเขียนได้ทั้ง installments/contracts/other_income/pj_auto_dueday_log โดยไม่ติด
-- RLS ของแต่ละตาราง (เหมือน autoclose_contract_if_fully_paid/submit_for_review ที่ทำมาก่อนแล้ว) —
-- ปลอดภัยเพราะ execute ถูกจำกัดให้ service_role เท่านั้น (ดู revoke/grant ท้ายฟังก์ชัน) ไม่มีทางให้
-- staff/freelancer/anon เรียกตรงได้เลย

create or replace function public.pj_auto_dueday_shift(
  p_contract_id uuid,
  p_old_due_day int,
  p_new_due_day int,
  p_installment_updates jsonb,
  p_fee_amount numeric,
  p_fee_category text,
  p_fee_kind text,
  p_fee_note text,
  p_fee_received_at date,
  p_pj_invoice_no text,
  p_pj_paid_date date,
  p_run_id uuid,
  p_created_by text default 'PJ Auto-Sync'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_item              jsonb;
  v_installment_id    uuid;
  v_new_due_date      date;
  v_row               record;
  v_before            jsonb := '[]'::jsonb;
  v_after             jsonb := '[]'::jsonb;
  v_other_income_id   uuid;
  v_log_id            uuid;
  v_contract_status   text;
  v_update_count      int := 0;
begin
  if p_new_due_day is null or p_new_due_day < 1 or p_new_due_day > 31 then
    raise exception 'new_due_day ไม่ถูกต้อง (%)', p_new_due_day;
  end if;
  if p_installment_updates is null or jsonb_typeof(p_installment_updates) <> 'array'
     or jsonb_array_length(p_installment_updates) = 0 then
    raise exception 'ไม่มีงวดให้แก้ (installment_updates ว่างหรือไม่ใช่ array)';
  end if;

  -- ล็อกแถวสัญญา + verify ยัง active จริง (กัน race — เผื่อสถานะเปลี่ยนระหว่างที่ Edge Function
  -- ตัดสินใจกับตอน RPC นี้รันจริง เช่น ลูกค้าคืนเครื่อง/ปิดสัญญาไปพอดี)
  select status into v_contract_status
    from public.contracts
   where id = p_contract_id
     for update;
  if not found then
    raise exception 'ไม่พบสัญญา (contract_id=%)', p_contract_id;
  end if;
  if v_contract_status <> 'active' then
    raise exception 'สัญญาไม่ใช่ active แล้ว (status=%) — ยกเลิกการเลื่อนวันครบกำหนด', v_contract_status;
  end if;

  for v_item in select * from jsonb_array_elements(p_installment_updates)
  loop
    v_installment_id := (v_item->>'installment_id')::uuid;
    v_new_due_date := (v_item->>'new_due_date')::date;

    -- ล็อกแถวงวด + verify ซ้ำ (กติกาข้อ D): ยัง paid_amount=0 และ new_due_date ต้อง > current_date จริง
    -- ณ เวลาที่ RPC รัน (ไม่ใช่แค่ตอน Edge Function คำนวณ decision ไว้ก่อนหน้า)
    select id, installment_no, due_date, paid_amount into v_row
      from public.installments
     where id = v_installment_id and contract_id = p_contract_id
     for update;

    if not found then
      raise exception 'ไม่พบงวด id=% ของสัญญานี้', v_installment_id;
    end if;
    if coalesce(v_row.paid_amount, 0) <> 0 then
      raise exception 'งวดที่ % มีเงินจ่ายเข้ามาแล้ว (paid_amount=%) ระหว่างทาง ห้ามเลื่อนวัน',
        v_row.installment_no, v_row.paid_amount;
    end if;
    if not (v_new_due_date > current_date) then
      raise exception 'งวดที่ % วันใหม่ (%) ต้องมากกว่าวันนี้ (%) เท่านั้น',
        v_row.installment_no, v_new_due_date, current_date;
    end if;

    v_before := v_before || jsonb_build_object(
      'installment_id', v_row.id, 'installment_no', v_row.installment_no, 'due_date', v_row.due_date
    );

    update public.installments
       set due_date = v_new_due_date
     where id = v_installment_id;

    v_after := v_after || jsonb_build_object(
      'installment_id', v_row.id, 'installment_no', v_row.installment_no, 'due_date', v_new_due_date
    );

    v_update_count := v_update_count + 1;
  end loop;

  update public.contracts
     set due_day = p_new_due_day
   where id = p_contract_id;

  if p_fee_amount is not null and p_fee_amount > 0 then
    insert into public.other_income (
      contract_id, amount, category, note, received_at, recorded_by, fee_kind
    ) values (
      p_contract_id, p_fee_amount, coalesce(p_fee_category, 'ค่าเปลี่ยนวันที่ชำระ'), p_fee_note,
      coalesce(p_fee_received_at, current_date), coalesce(p_created_by, 'PJ Auto-Sync'),
      coalesce(p_fee_kind, 'due_day')
    )
    returning id into v_other_income_id;
  end if;

  insert into public.pj_auto_dueday_log (
    contract_id, pj_invoice_no, pj_paid_date, old_due_day, new_due_day,
    installments_before, installments_after, other_income_id, run_id,
    mode, status, created_by
  ) values (
    p_contract_id, p_pj_invoice_no, p_pj_paid_date, p_old_due_day, p_new_due_day,
    v_before, v_after, v_other_income_id, p_run_id,
    'live', 'success', coalesce(p_created_by, 'PJ Auto-Sync')
  )
  returning id into v_log_id;

  return v_log_id;
end;
$$;

comment on function public.pj_auto_dueday_shift(
  uuid, int, int, jsonb, numeric, text, text, text, date, text, date, uuid, text
) is '(0161) atomic: เลื่อน due_date หลายงวด + contracts.due_day + other_income + pj_auto_dueday_log ในทรานแซกชันเดียว — เช็คซ้ำ paid_amount=0 และ new_due_date>current_date ต่องวดก่อนแก้จริง; raise exception = rollback ทั้งก้อน; execute เฉพาะ service_role';

-- ============================================================================
-- SECTION 5: GRANTs (ฟังก์ชัน) — service_role เท่านั้น (ติ๊ก RED #4)
-- ============================================================================

revoke all on function public.pj_auto_dueday_shift(
  uuid, int, int, jsonb, numeric, text, text, text, date, text, date, uuid, text
) from public;

revoke all on function public.pj_auto_dueday_shift(
  uuid, int, int, jsonb, numeric, text, text, text, date, text, date, uuid, text
) from anon;

revoke all on function public.pj_auto_dueday_shift(
  uuid, int, int, jsonb, numeric, text, text, text, date, text, date, uuid, text
) from authenticated;

grant execute on function public.pj_auto_dueday_shift(
  uuid, int, int, jsonb, numeric, text, text, text, date, text, date, uuid, text
) to service_role;

-- ============================================================================
-- SECTION 6: Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 6a) ตารางมีอยู่ + service_role มีสิทธิ์ครบ:
--   SELECT has_table_privilege('service_role', 'public.pj_auto_dueday_log', 'INSERT'); -- expected: true

-- 6b) authenticated มีแค่ SELECT (ไม่มี INSERT/UPDATE/DELETE):
--   SELECT has_table_privilege('authenticated', 'public.pj_auto_dueday_log', 'SELECT'); -- true
--   SELECT has_table_privilege('authenticated', 'public.pj_auto_dueday_log', 'INSERT'); -- false

-- 6c) RLS enabled:
--   SELECT rowsecurity FROM pg_class WHERE relname = 'pj_auto_dueday_log'; -- expected: true

-- 6d) policy มีแค่ 1 (admin read):
--   SELECT policyname FROM pg_policies WHERE tablename = 'pj_auto_dueday_log';
--   -- expected: pj_auto_dueday_log_admin_read

-- 6e) index ครบ:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'pj_auto_dueday_log' ORDER BY indexname;
--   -- expected: pj_auto_dueday_log_contract_idx, pj_auto_dueday_log_pkey, pj_auto_dueday_log_run_idx

-- 6f) status/error column มีอยู่:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='pj_auto_dueday_log' AND column_name IN ('status','error');

-- 6g) RPC execute grant ถูกเฉพาะ service_role (ตัวอย่างเช็คด้วย has_function_privilege):
--   SELECT has_function_privilege('service_role',
--     'public.pj_auto_dueday_shift(uuid,int,int,jsonb,numeric,text,text,text,date,text,date,uuid,text)',
--     'EXECUTE'); -- expected: true
--   SELECT has_function_privilege('authenticated',
--     'public.pj_auto_dueday_shift(uuid,int,int,jsonb,numeric,text,text,text,date,text,date,uuid,text)',
--     'EXECUTE'); -- expected: false
--   SELECT has_function_privilege('anon',
--     'public.pj_auto_dueday_shift(uuid,int,int,jsonb,numeric,text,text,text,date,text,date,uuid,text)',
--     'EXECUTE'); -- expected: false

-- 6h) ทดสอบ atomic rollback จริง (begin/rollback เท่านั้น ห้าม commit) — ยิง installment_id ที่ไม่มีจริง
--     ปนกับที่มีจริงในชุดเดียวกัน แล้วเช็คว่างวดที่มีจริงไม่ถูกแก้เลย (rollback ทั้งก้อน):
-- begin;
--   select public.pj_auto_dueday_shift(
--     '<contract_id>'::uuid, 25, 5,
--     jsonb_build_array(
--       jsonb_build_object('installment_id', '<installment_id_จริง>', 'new_due_date', '2099-01-05'),
--       jsonb_build_object('installment_id', gen_random_uuid(), 'new_due_date', '2099-01-05') -- ไม่มีจริง ต้อง raise
--     ),
--     500, 'ค่าเปลี่ยนวันที่ชำระ', 'due_day', 'smoke test 0161', current_date,
--     'TEST-INV-0161', current_date, null, 'smoke-test'
--   );
--   -- expected: ERROR ไม่พบงวด id=...
--   select due_date from public.installments where id = '<installment_id_จริง>';
--   -- expected: วันเดิม (ไม่ถูกแก้เลย — ยืนยัน atomic)
-- rollback;
