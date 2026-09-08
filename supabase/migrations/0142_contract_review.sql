-- 0142: ระบบตรวจเคสก่อนส่งอีเมลบริษัท (contract_review) — คุณเตย/แอดมินตรวจรูป+ข้อมูลก่อนอนุมัติส่ง
-- อ้างอิง spec-review-flow.md (แบม, owner-approved 2026-09-08) §1 state machine + §4 จุดที่ต้องล็อก
--
-- เป้าหมาย: เพิ่มสถานะตรวจ (pending_review/needs_fix/approved) บนสัญญา + ประวัติการตรวจแบบ append-only
-- + RPC ทั้ง 3 ทางเดียวที่เปลี่ยนสถานะได้จริง (submit_for_review/approve_review/reject_review) — กัน
-- ไม่ให้ client เขียน review_status ตรงๆ ผ่าน updateContract (RLS ปกติของ contracts ไม่ครอบคอลัมน์นี้
-- เป็นพิเศษ แต่ path ที่ตั้งใจให้ใช้มีทางเดียวคือ RPC เหล่านี้ — น้องวิว/db.ts ต้องเรียกผ่าน RPC เท่านั้น)
--
-- design: review_status เก็บแค่ 3 ค่า ('pending_review'|'needs_fix'|'approved') หรือ NULL
--   NULL ครอบคลุม 2 เคสที่แยกกันฝั่ง TS (review.ts ของแบม) แต่ไม่แยกกันที่ DB:
--     1) สัญญาเก่าก่อน cutoff (media_gate_from) — ยกเว้นทุกกฎถาวร ไม่เข้า flow นี้เลย
--     2) สัญญาใหม่ที่ยังไม่กด "ส่งให้คุณเตยตรวจ" ครั้งแรก (draft ฝั่ง TS)
--   เหตุผลรวมเป็นค่าเดียว: ไม่มี default บนคอลัมน์ + submit_for_review รับได้ทั้ง NULL/needs_fix เป็น
--   จุดเริ่มส่งตรวจ ไม่ต้องมี migration backfill แยก แถมไม่ต้องมี "cutoff ที่สอง" ตามที่ spec ขอ
--   (reuse เดียวกับ media_gate_from — ฝั่ง TS จะแยกแสดงป้าย "ไม่มีข้อมูล" (เก่า) vs "ยังไม่ส่งตรวจ" (draft)
--   เองจาก createdAt เทียบ media_gate_from ไม่ใช่หน้าที่ตาราง/RPC ในไฟล์นี้)
--
-- Additive ทั้งหมด — ไม่แตะ/ลบตาราง/คอลัมน์เดิม

-- ============================================================================
-- SECTION 1: คอลัมน์สถานะตรวจบน contracts
-- ============================================================================

alter table public.contracts
  add column if not exists review_status text,
  add column if not exists review_updated_at timestamptz,
  add column if not exists review_updated_by uuid references auth.users (id) on delete set null;

alter table public.contracts drop constraint if exists contracts_review_status_check;
alter table public.contracts add constraint contracts_review_status_check
  check (review_status is null or review_status in ('pending_review', 'needs_fix', 'approved'));

comment on column public.contracts.review_status is
  'สถานะระบบตรวจก่อนส่งอีเมลบริษัท (0142) — null = สัญญาเก่า/ยังไม่ส่งตรวจ (unrestricted), pending_review/needs_fix/approved = อยู่ใน flow. เปลี่ยนได้ทาง RPC submit_for_review/approve_review/reject_review เท่านั้น';
comment on column public.contracts.review_updated_at is 'เวลาที่ review_status เปลี่ยนล่าสุด (ใช้คำนวณ "ค้างมา N วัน" ด้วย — submitted_at/rejected_at ใช้ค่าเดียวกันนี้ตามสถานะปัจจุบัน)';
comment on column public.contracts.review_updated_by is 'ผู้ทำให้ review_status เปลี่ยนล่าสุด (auth.uid() ตอนเรียก RPC)';

-- ============================================================================
-- SECTION 2: ตาราง contract_review_log — ประวัติการตรวจแบบ append-only
-- เขียนได้ทาง RPC ด้านล่าง (SECURITY DEFINER) หรือ service_role เท่านั้น — ไม่มี INSERT/UPDATE/DELETE
-- policy ให้ authenticated เขียนตรง กัน log ปลอม/แก้ย้อนหลัง (pattern เดียวกับ email_send_log 0138)
-- ============================================================================

create table if not exists public.contract_review_log (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  from_status text,
  to_status   text not null,
  action      text not null check (action in ('submit', 'approve', 'reject', 'cancel_approval')),
  reason      text,
  actor       uuid references auth.users (id) on delete set null,
  actor_role  text,
  created_at  timestamptz not null default now()
);

create index if not exists contract_review_log_contract_idx
  on public.contract_review_log (contract_id, created_at desc);

comment on table public.contract_review_log is
  'ประวัติการเปลี่ยนสถานะตรวจก่อนส่งอีเมล (submit/approve/reject/cancel_approval) แบบ append-only — เขียนได้ทาง RPC submit_for_review/approve_review/reject_review หรือ service_role เท่านั้น ห้ามแก้ย้อนหลัง';

alter table public.contract_review_log enable row level security;

drop policy if exists contract_review_log_select on public.contract_review_log;
create policy contract_review_log_select
  on public.contract_review_log
  for select to authenticated
  using (is_admin() or is_staff() or is_accounting());

-- ไม่มี INSERT/UPDATE/DELETE policy สำหรับ authenticated เลย — เขียนได้ทาง RPC (SECURITY DEFINER)
-- ด้านล่าง หรือ service_role เท่านั้น

grant select on public.contract_review_log to authenticated;
grant select, insert, update, delete on public.contract_review_log to service_role;

-- ============================================================================
-- SECTION 3: media_gate_complete(contract_id) — ใช้ร่วมกับ submit_for_review
-- re-implement evaluateGate (ย่อจาก supabase/functions/send-company-email/index.ts) ฝั่ง SQL
-- ครอบ 3 อย่างในฟังก์ชันเดียว ตรงกับพฤติกรรม send-company-email ทุกจุด:
--   1) isGated (media_gate_from เทียบ created_at แบบ UTC date) — ไม่ gated = complete เสมอ
--   2) admin กด "ข้ามการตรวจ" ไว้แล้ว (contract_media_gate_override มีแถว) = complete เสมอ
--   3) นับไฟล์ต่อช่องจาก contract_media จริง เทียบ min ต่อช่องใน app_settings.media_slots
-- SECURITY DEFINER เพราะ staff ผู้เรียก submit_for_review ไม่ควรต้องมีสิทธิ์อ่านตรงทุกตารางที่ใช้เช็ค
-- ตั้งใจ export ให้ Edge Function เรียกผ่าน .rpc('media_gate_complete', ...) ได้ในอนาคตด้วย (ยังไม่แก้
-- send-company-email/index.ts ให้เรียกจริงตอนนี้ — คงของเดิมไว้ตามสโคปงานนี้ กันข้าง diff บาน)
-- ============================================================================

create or replace function public.media_gate_complete(p_contract_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_created_at   timestamptz;
  v_condition    text;
  v_origin       text;
  v_credit_flag  boolean;
  v_gate_from    text;
  v_override     boolean;
  v_slots        jsonb;
  v_counts       jsonb;
  v_slot         jsonb;
  v_required     boolean;
begin
  select created_at, condition, origin, credit_history_found
    into v_created_at, v_condition, v_origin, v_credit_flag
  from public.contracts
  where id = p_contract_id;

  if not found then
    -- ไม่พบสัญญา — ให้ caller (RPC ที่เรียกฟังก์ชันนี้) เจอ error "ไม่พบสัญญา" จากขั้นตอนอื่นแทน
    return false;
  end if;

  select value into v_gate_from from public.app_settings where key = 'media_gate_from';
  v_gate_from := coalesce(v_gate_from, '2026-09-09');

  if v_created_at is null or (v_created_at at time zone 'utc')::date < v_gate_from::date then
    return true; -- ไม่ gated (สัญญาเก่ากว่า cutoff หรือไม่มี created_at)
  end if;

  select exists(
    select 1 from public.contract_media_gate_override where contract_id = p_contract_id
  ) into v_override;
  if v_override then
    return true; -- แอดมินกดข้ามการตรวจไฟล์ไว้แล้ว (log_media_gate_bypass, 0137)
  end if;

  select value::jsonb into v_slots from public.app_settings where key = 'media_slots';
  v_slots := coalesce(v_slots, '[]'::jsonb);

  select coalesce(jsonb_object_agg(s.slot_key, s.cnt), '{}'::jsonb) into v_counts
  from (
    select slot_key, count(*) as cnt
    from public.contract_media
    where contract_id = p_contract_id and deleted_at is null
    group by slot_key
  ) s;
  v_counts := coalesce(v_counts, '{}'::jsonb);

  for v_slot in select * from jsonb_array_elements(v_slots)
  loop
    v_required := case
      when v_slot ->> 'required' = 'always' then true
      when v_slot ->> 'required' = 'never' then false
      when jsonb_typeof(v_slot -> 'required') = 'object' and v_slot -> 'required' ->> 'when' = 'condition'
        then v_condition = (v_slot -> 'required' ->> 'equals')
      when jsonb_typeof(v_slot -> 'required') = 'object' and v_slot -> 'required' ->> 'when' = 'flag'
        -- ตอนนี้มี flag เดียวคือ credit_history_found (0136/0137 slot 13.1) — เผื่อ flag ใหม่ในอนาคต
        -- เพิ่ม when ต่อในเคสนี้ได้ ไม่ต้องแก้โครงฟังก์ชัน
        then case (v_slot -> 'required' ->> 'name')
               when 'credit_history_found' then coalesce(v_credit_flag, false)
               else false
             end
      else false
    end;

    if v_required then
      if coalesce((v_counts ->> (v_slot ->> 'key'))::int, 0) < coalesce((v_slot ->> 'min')::int, 0) then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;

grant execute on function public.media_gate_complete(uuid) to authenticated, service_role;

comment on function public.media_gate_complete(uuid) is
  '(0142) true = สัญญานี้ผ่านเกณฑ์รูปครบ (หรือไม่ถูก gate / แอดมินข้ามการตรวจไว้แล้ว) — mirror evaluateGate ของ send-company-email/index.ts ใช้เป็น guard ของ submit_for_review';

-- ============================================================================
-- SECTION 4: RPC submit_for_review — staff/admin กด "ส่งให้คุณเตยตรวจ"
-- mirror ข้อความ error จาก src/lib/review.ts nextStatus() action='submit' ทุกตัวอักษร
-- ============================================================================

create or replace function public.submit_for_review(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_active  boolean;
  v_current text;
begin
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    raise exception 'ไม่มีสิทธิ์ส่งตรวจ';
  end if;

  select review_status into v_current from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญา';
  end if;

  if v_current is not null and v_current is distinct from 'needs_fix' then
    raise exception 'ส่งตรวจได้เฉพาะเคสที่ยังไม่ส่งตรวจ หรือถูกตีกลับให้แก้ไขเท่านั้น';
  end if;

  if not public.media_gate_complete(p_contract_id) then
    raise exception 'แนบรูปให้ครบทุกช่องก่อน จึงส่งตรวจได้';
  end if;

  update public.contracts
     set review_status = 'pending_review',
         review_updated_at = now(),
         review_updated_by = auth.uid()
   where id = p_contract_id;

  insert into public.contract_review_log (contract_id, from_status, to_status, action, reason, actor, actor_role)
  values (p_contract_id, v_current, 'pending_review', 'submit', null, auth.uid(), v_role);
end;
$$;

grant execute on function public.submit_for_review(uuid) to authenticated, service_role;

comment on function public.submit_for_review(uuid) is
  '(0142) admin/staff (active) ส่งเคสให้แอดมินตรวจ — จาก null/needs_fix เท่านั้น + ต้องผ่าน media_gate_complete; error ตรงกับ src/lib/review.ts nextStatus(action=submit)';

-- ============================================================================
-- SECTION 5: RPC approve_review — admin กด "✓ ตรวจแล้ว" (ส่งเมลหรือไม่ส่ง เป็นงานของ client แยก)
-- mirror ข้อความ error จาก nextStatus() action='approve'
-- ============================================================================

create or replace function public.approve_review(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  select review_status into v_current from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญา';
  end if;

  if not is_admin() then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ตรวจผ่านเคสได้';
  end if;

  if v_current is distinct from 'pending_review' then
    raise exception 'ตรวจผ่านได้เฉพาะเคสที่อยู่ในสถานะรอตรวจ';
  end if;

  update public.contracts
     set review_status = 'approved',
         review_updated_at = now(),
         review_updated_by = auth.uid()
   where id = p_contract_id;

  insert into public.contract_review_log (contract_id, from_status, to_status, action, reason, actor, actor_role)
  values (p_contract_id, v_current, 'approved', 'approve', null, auth.uid(), 'admin');
end;
$$;

grant execute on function public.approve_review(uuid) to authenticated, service_role;

comment on function public.approve_review(uuid) is
  '(0142) admin เท่านั้น ตรวจผ่านเคส — จาก pending_review เท่านั้น -> approved ทันที (ล็อก staff แก้ไม่ได้แม้ยังไม่ส่งเมล); ส่งเมล (approve_and_send) เป็น 2 ก้าวฝั่ง client: เรียกฟังก์ชันนี้ก่อน แล้วค่อยเรียก send-company-email; error ตรงกับ src/lib/review.ts nextStatus(action=approve)';

-- ============================================================================
-- SECTION 6: RPC reject_review — admin ตีกลับ (จาก pending_review) หรือยกเลิกการตรวจ (จาก approved)
-- 2 pure action ของแบม (reject/unapprove) รวมเป็น RPC เดียวเพราะ target state เดียวกัน (needs_fix)
-- และสถานะต้นทางไม่ทับกัน — action ที่ log แยกตามสถานะต้นทางจริง (reject vs cancel_approval)
-- mirror ข้อความ error จาก nextStatus() action='reject' และ action='unapprove' ตามสถานะต้นทาง
-- ============================================================================

create or replace function public.reject_review(p_contract_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_action  text;
begin
  select review_status into v_current from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญา';
  end if;

  if v_current is distinct from 'pending_review' and v_current is distinct from 'approved' then
    raise exception 'ตีกลับ/ยกเลิกการตรวจได้เฉพาะเคสที่อยู่ในสถานะรอตรวจ หรือตรวจผ่านแล้วเท่านั้น';
  end if;

  if not is_admin() then
    if v_current = 'approved' then
      raise exception 'เฉพาะแอดมินเท่านั้นที่ยกเลิกการตรวจได้';
    else
      raise exception 'เฉพาะแอดมินเท่านั้นที่ตีกลับเคสได้';
    end if;
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    if v_current = 'approved' then
      raise exception 'ต้องกรอกเหตุผลที่ยกเลิกการตรวจ';
    else
      raise exception 'ต้องกรอกเหตุผลที่ต้องแก้ไข';
    end if;
  end if;

  v_action := case when v_current = 'approved' then 'cancel_approval' else 'reject' end;

  update public.contracts
     set review_status = 'needs_fix',
         review_updated_at = now(),
         review_updated_by = auth.uid()
   where id = p_contract_id;

  insert into public.contract_review_log (contract_id, from_status, to_status, action, reason, actor, actor_role)
  values (p_contract_id, v_current, 'needs_fix', v_action, btrim(p_reason), auth.uid(), 'admin');
end;
$$;

grant execute on function public.reject_review(uuid, text) to authenticated, service_role;

comment on function public.reject_review(uuid, text) is
  '(0142) admin เท่านั้น, reason บังคับไม่ว่าง — จาก pending_review -> needs_fix (log action=reject, "ตีกลับ") หรือจาก approved -> needs_fix (log action=cancel_approval, "ยกเลิกการตรวจ" — ไม่แตะ email_sent_at เดิม); error ตรงกับ src/lib/review.ts nextStatus(action=reject/unapprove) ตามสถานะต้นทาง';

-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (MCP)
-- ============================================================================

-- a) คอลัมน์ + constraint ครบ:
-- select column_name, data_type from information_schema.columns
--  where table_name='contracts' and column_name in ('review_status','review_updated_at','review_updated_by');
-- select conname from pg_constraint where conname = 'contracts_review_status_check';

-- b) service_role เข้าถึง contract_review_log ได้ (Edge Function/future use จะพังถ้าไม่ผ่าน):
-- select has_table_privilege('service_role', 'public.contract_review_log', 'SELECT');
-- select has_table_privilege('service_role', 'public.contract_review_log', 'INSERT');

-- c) authenticated ไม่มีสิทธิ์ insert/update/delete ตรงบน contract_review_log (เขียนได้ทาง RPC เท่านั้น):
-- select count(*) from pg_policies where tablename='contract_review_log' and cmd in ('INSERT','UPDATE','DELETE');
-- expected: 0

-- d) 3 RPC + media_gate_complete สร้างสำเร็จ, authenticated เรียกได้:
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name in
--  ('media_gate_complete','submit_for_review','approve_review','reject_review');
-- expected: 4 rows
-- select has_function_privilege('authenticated','public.submit_for_review(uuid)','EXECUTE');
-- select has_function_privilege('authenticated','public.approve_review(uuid)','EXECUTE');
-- select has_function_privilege('authenticated','public.reject_review(uuid,text)','EXECUTE');

-- e) trace state machine เต็ม (ทดสอบผ่าน session staff/admin จริง — service_role ไม่มี auth.uid() ที่ map
--    เป็น profile ได้ ต้องทดสอบผ่านแอปจริง/JWT):
--   begin;
--     select public.submit_for_review('<contract_id_draft_media_incomplete>'::uuid);
--     -- expected: ERROR แนบรูปให้ครบทุกช่องก่อน จึงส่งตรวจได้
--     select public.submit_for_review('<contract_id_draft_media_complete>'::uuid); -- session staff
--     -- expected: ผ่าน, review_status -> pending_review
--     select public.approve_review('<same_id>'::uuid); -- session staff
--     -- expected: ERROR เฉพาะแอดมินเท่านั้นที่ตรวจผ่านเคสได้
--     select public.approve_review('<same_id>'::uuid); -- session admin
--     -- expected: ผ่าน, review_status -> approved
--     select public.reject_review('<same_id>'::uuid, ''); -- session admin, reason ว่าง
--     -- expected: ERROR ต้องกรอกเหตุผลที่ยกเลิกการตรวจ (เพราะ current=approved)
--     select public.reject_review('<same_id>'::uuid, 'ทดสอบยกเลิก'); -- session admin
--     -- expected: ผ่าน, review_status -> needs_fix, log action=cancel_approval
--     select action, from_status, to_status, reason from public.contract_review_log
--       where contract_id = '<same_id>'::uuid order by created_at;
--   rollback;

-- f) legacy (review_status ยังเป็น null) ไม่ถูกกระทบ — ต้อง query ปกติได้เหมือนก่อน migration:
-- select count(*) from public.contracts where review_status is null;
-- (ตัวเลขควร = จำนวนสัญญาทั้งหมด ก่อนมีใครกด submit_for_review ครั้งแรกหลัง apply)
