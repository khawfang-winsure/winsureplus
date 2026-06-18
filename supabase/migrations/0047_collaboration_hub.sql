-- 0047: ศูนย์ประสานงานลูกค้า (Collaboration Hub)
-- 5 ส่วน:
--   1) เพิ่ม 'line_pending' ใน CHECK constraint ของ follow_ups.follow_up_result
--   2) ตาราง queue_case_seen (badge เวลาฟรีแลนซ์เปิดเคสล่าสุด)
--   3) ตาราง inbox_pins (admin/staff หยิบเคสเข้ากล่อง)
--   4) CREATE OR REPLACE enforce_contact_compliance() เพิ่มยกเว้น line_pending (inbound)
--   5) CREATE OR REPLACE v_follow_up_stats_90d — เพิ่ม line_pending ใน successful_attempts
--
-- ⚠️ ครีมระวัง apply: ส่วนนี้ทั้งหมดเป็น TEXT CHECK constraint ไม่ใช่ ENUM
--    → รันใน transaction ปกติได้เลย ไม่ต้องแยก statement
--
-- Pete decision 2026-06-18: line_pending = ลูกค้า initiate ติดต่อมาเอง (inbound, ไม่มีข้อจำกัด)

-- ============================================================================
-- SECTION 1: เพิ่ม 'line_pending' ใน follow_up_result CHECK constraint
-- ============================================================================
-- follow_up_result ถูกสร้างเป็น inline unnamed CHECK ใน 0018 line 81
-- Postgres auto-generate ชื่อว่า: follow_ups_follow_up_result_check
--
-- ⚠️ ครีม verify ก่อน apply:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.follow_ups'::regclass AND contype = 'c'
--    AND conname LIKE '%follow_up_result%';
--    ต้องเห็น: follow_ups_follow_up_result_check
--    ถ้าชื่อต่างออกไป → แก้ชื่อใน DROP CONSTRAINT ด้านล่างก่อน apply
--
-- Pattern: DROP เดิม + ADD ใหม่ (additive value list รวม line_pending)
-- ทำใน transaction เดียวกันได้ — TEXT CHECK ไม่ใช่ ENUM (no out-of-txn restriction)

alter table public.follow_ups
  drop constraint if exists follow_ups_follow_up_result_check;

alter table public.follow_ups
  add constraint follow_ups_follow_up_result_check
    check (follow_up_result in (
      'contacted',
      'no_answer',
      'promised',
      'refused',
      'paid',
      'returned',
      'other',
      'line_pending'   -- ใหม่ 0047: ลูกค้า initiate ผ่าน Line (inbound — ยกเว้นกฎ พ.ร.บ.)
    ));

-- ============================================================================
-- SECTION 2: ตาราง queue_case_seen
-- บันทึกเวลาฟรีแลนซ์เปิด/บันทึกเคสล่าสุด → UI ใช้คำนวณ "badge ใหม่"
-- ============================================================================
-- หมายเหตุ: last_seen_at default now() ฝั่ง server
--   db.ts จะ upsert โดยไม่ส่ง timestamp มาจาก client
--   → กัน bug เทียบเวลา client timezone Z vs server +00:00

create table if not exists public.queue_case_seen (
  freelancer_id uuid not null references profiles(id)  on delete cascade,
  contract_id   uuid not null references contracts(id) on delete cascade,
  last_seen_at  timestamptz not null default now(),    -- server-side เสมอ
  primary key (freelancer_id, contract_id)
);

alter table public.queue_case_seen enable row level security;

-- Trigger: refresh last_seen_at := now() ทุกครั้ง (INSERT + UPDATE path)
-- ปัญหา: `default now()` ทำงานเฉพาะ INSERT ใหม่
--   upsert ที่ชนกุญแจ (on conflict do update) → เข้า UPDATE path → default ไม่ fire
--   → last_seen_at ค้างค่าเดิมจาก INSERT ครั้งแรก (ฟัง badge แต่เวลาไม่เปลี่ยน)
-- Fix: BEFORE INSERT OR UPDATE trigger บังคับ set last_seen_at := now() เสมอ
--   ผลพลอยได้: กัน client ส่ง timestamp มาเองทั้ง INSERT และ UPDATE path
create or replace function public.touch_queue_case_seen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.last_seen_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_queue_case_seen on public.queue_case_seen;
create trigger trg_touch_queue_case_seen
  before insert or update on public.queue_case_seen
  for each row execute function public.touch_queue_case_seen();

-- RLS policies
-- SELECT: freelancer เห็นแถวตัวเอง, admin + staff เห็นทั้งหมด
drop policy if exists qcs_select on public.queue_case_seen;
create policy qcs_select on public.queue_case_seen
  for select to authenticated
  using (
    freelancer_id = auth.uid()
    OR is_admin()
    OR is_staff()
  );

-- INSERT: freelancer_id ต้องตรงกับ caller เท่านั้น (anti-spoof)
drop policy if exists qcs_insert on public.queue_case_seen;
create policy qcs_insert on public.queue_case_seen
  for insert to authenticated
  with check (freelancer_id = auth.uid());

-- UPDATE: ใช้สำหรับ upsert (on conflict do update last_seen_at)
--   using clause ป้องกันไม่ให้ update แถวของ freelancer คนอื่น
--   with check ป้องกันไม่ให้เปลี่ยน freelancer_id ตอน update
drop policy if exists qcs_update on public.queue_case_seen;
create policy qcs_update on public.queue_case_seen
  for update to authenticated
  using    (freelancer_id = auth.uid())
  with check (freelancer_id = auth.uid());

-- GRANTs: 0005 ALTER DEFAULT PRIVILEGES ครอบ select/insert/update/delete ให้ authenticated แล้ว
-- ด้านล่างเป็น explicit belt-and-suspenders ตาม pattern 0018/0019
-- service_role: 0017 default privileges ครอบ SELECT/INSERT/UPDATE/DELETE → explicit สำหรับ audit trail
grant select, insert, update, delete on public.queue_case_seen to service_role;
-- authenticated: explicit ครอบ 3 operations ที่ policies อนุญาต (ไม่มี DELETE policy = ไม่ grant)
grant select, insert, update on public.queue_case_seen to authenticated;

-- ⚠️ ครีม verify หลัง apply:
-- SELECT has_table_privilege('service_role', 'public.queue_case_seen', 'SELECT'); -- expected: true
-- SELECT has_table_privilege('authenticated', 'public.queue_case_seen', 'INSERT'); -- expected: true

-- ============================================================================
-- SECTION 3: ตาราง inbox_pins
-- admin/staff หยิบเคสเข้ากล่องรับงานเอง (pinned inbox)
-- ============================================================================

create table if not exists public.inbox_pins (
  contract_id    uuid primary key references contracts(id) on delete cascade,
  pinned_by_id   uuid not null references profiles(id),
  pinned_by_name text not null,
  pinned_at      timestamptz not null default now()
);

alter table public.inbox_pins enable row level security;

-- RLS policies: admin + staff ทำได้ทุกอย่าง; freelancer เข้าไม่ได้
-- SELECT
drop policy if exists ip_select on public.inbox_pins;
create policy ip_select on public.inbox_pins
  for select to authenticated
  using (is_admin() OR is_staff());

-- INSERT
drop policy if exists ip_insert on public.inbox_pins;
create policy ip_insert on public.inbox_pins
  for insert to authenticated
  with check (is_admin() OR is_staff());

-- UPDATE (เช่น เปลี่ยน pinned_by_name ถ้ามีการ reassign)
drop policy if exists ip_update on public.inbox_pins;
create policy ip_update on public.inbox_pins
  for update to authenticated
  using    (is_admin() OR is_staff())
  with check (is_admin() OR is_staff());

-- DELETE (unpin)
drop policy if exists ip_delete on public.inbox_pins;
create policy ip_delete on public.inbox_pins
  for delete to authenticated
  using (is_admin() OR is_staff());

-- GRANTs: explicit belt-and-suspenders
grant select, insert, update, delete on public.inbox_pins to service_role;
grant select, insert, update, delete on public.inbox_pins to authenticated;

-- ⚠️ ครีม verify หลัง apply:
-- SELECT has_table_privilege('service_role', 'public.inbox_pins', 'SELECT');      -- expected: true
-- SELECT has_table_privilege('authenticated', 'public.inbox_pins', 'DELETE');     -- expected: true

-- ============================================================================
-- SECTION 4: CREATE OR REPLACE enforce_contact_compliance()
--            เพิ่มยกเว้น line_pending (Pete decision 2026-06-18)
-- ============================================================================
-- Reproduced verbatim จาก 0019 — เปลี่ยนเพียง: เพิ่ม line_pending exempt block
-- ลำดับ invariant (รักษาทุกอย่างจาก 0019):
--   (1) kill-switch → (2) admin exempt → (3) line_pending exempt [NEW] → (4) can_contact_at
--   → (5) no_answer bypass DAILY_CAP → (6) block หรือ pass
--
-- kill-switch ยังครอบ line_pending (if not v_enabled → return ก่อนถึง exempt)
--   → Pete intent: line_pending exempt ทำงานเฉพาะตอน enforcement เปิด
--   ถ้า enforcement ปิด (kill-switch) → return new ก่อน → line_pending ผ่านโดยอัตโนมัติ
--   invariant ปลอดภัย
--
-- ห้าม DROP/RECREATE trigger trg_enforce_contact_compliance — ใช้ CREATE OR REPLACE function เท่านั้น
--
-- ⚠️ NOTE ด้านผลิตภัณฑ์ (ไม่แก้ในไฟล์นี้ — flag สำหรับ Pete/ครีม):
--    can_contact_at() นับ line_pending เป็น "ติดต่อแล้ว" (is distinct from 'no_answer')
--    → line_pending row จะเผา daily cap ของ outbound calls ถัดไปในวันเดียวกัน
--    อาจไม่ตรง intent (inbound ไม่ควรนับ outbound quota) แต่แก้ไขอยู่นอก scope 0047
--    Pete decision required ก่อนแก้ can_contact_at() signature

create or replace function public.enforce_contact_compliance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_enabled     boolean;
  v_block_code  text;
  v_caller_role text;
begin
  -- (1) Kill-switch
  -- fail-safe: coalesce → 'true' ถ้า row หาย = enforcement ON
  -- <> 'false' = ปิดเฉพาะเมื่อพิมพ์ 'false' ตรงๆ (PDPA legal ควร fail-safe)
  select coalesce(value, 'true') <> 'false' into v_enabled
  from public.app_settings
  where key = 'contact_enforcement_enabled';

  if v_enabled is null then v_enabled := true; end if;
  if not v_enabled then return new; end if;

  -- (2) Admin exempt — override 24 ชม. ได้ (Pete decision #5 จาก 0019)
  select role into v_caller_role
  from public.profiles
  where id = auth.uid();

  if v_caller_role = 'admin' then return new; end if;

  -- (3) line_pending exempt [NEW 0047]
  -- Pete decision 2026-06-18: line_pending = ลูกค้า initiate ติดต่อมาเอง (inbound)
  -- กฎ พ.ร.บ. ทวงหนี้คุม outbound (เราโทรหาลูกค้า) ไม่ใช่ inbound (ลูกค้าทักมา)
  -- Pete ยืนยัน: DNC + line_pending ก็ผ่านได้ (ลูกค้า initiate เอง)
  -- ใช้ = ไม่ใช่ is not null — NULL ต้องตกผ่านไปตรวจ can_contact_at ตามปกติ
  if new.follow_up_result = 'line_pending' then return new; end if;

  -- (4) ตรวจเวลา/flag ด้วย can_contact_at
  v_block_code := public.can_contact_at(new.contract_id, now());

  -- (5) no_answer bypass DAILY_CAP (Pete decision #1 จาก 0019, Fix #1)
  -- Option B: trigger-side override — ไม่กระทบ signature ของ can_contact_at
  -- ปลอดภัยเพราะ: can_contact_at ตรวจ cap เป็น check สุดท้าย
  -- → ถ้า return DAILY_CAP = ผ่าน hours+DNC+lawyer แล้ว → safe ให้ผ่านสำหรับ no_answer
  if v_block_code = 'DAILY_CAP' and new.follow_up_result = 'no_answer' then
    v_block_code := null;
  end if;

  -- (6) block หรือ pass
  if v_block_code is not null then
    raise exception using
      errcode = 'P0001',
      message  = v_block_code;
  end if;

  return new;
end;
$$;

-- ไม่ recreate trigger — function เดิม trg_enforce_contact_compliance ยังอ้าง function เดิมชื่อเดิม
-- CREATE OR REPLACE function = trigger ยังคง fire function ที่อัปเดตแล้วอัตโนมัติ

-- ============================================================================
-- SECTION 5: CREATE OR REPLACE v_follow_up_stats_90d
-- เพิ่ม 'line_pending' ใน successful_attempts filter
-- ============================================================================
-- ต้นฉบับ: 0020_priority_promise.sql SECTION 3
-- Pete decision 2026-06-18: line_pending = inbound (ลูกค้า initiate) → นับเป็น "ติดต่อสำเร็จ"
--   → สัญญาที่ลูกค้าทักมาเองจะไม่เด้งใน ESCALATE alert (getEscalateContracts)
--   → ตรงกับ client reduce ใน getFreelancerQueue (Wave 3)
--
-- ห้ามแตะ: v_freelancer_performance / get_collector_scorecard (0046)
--   Pete decision: line_pending ไม่นับเป็นผลงานการโทรของคนตามหนี้ (scorecard คงเดิม)
--
-- Column set ไม่เปลี่ยน (CREATE OR REPLACE ทำได้ตรงๆ ไม่ต้อง DROP):
--   contract_id | total_attempts | successful_attempts | last_contacted_at | last_result
-- แก้เฉพาะ: IN-list ของ filter ใน successful_attempts — เพิ่ม 'line_pending' เข้า

create or replace view public.v_follow_up_stats_90d
  with (security_invoker = on) as
select
  f.contract_id,
  count(*)::int                                                       as total_attempts,
  count(*) filter (
    where f.follow_up_result in ('contacted','promised','paid','returned','other','line_pending')
  )::int                                                              as successful_attempts,
  max(f.created_at)                                                   as last_contacted_at,
  -- last_result: ผล ณ created_at ล่าสุด
  (array_agg(f.follow_up_result order by f.created_at desc))[1]       as last_result
from public.follow_ups f
where f.created_at >= now() - interval '90 days'
group by f.contract_id;

-- grant ซ้ำ (idempotent — CREATE OR REPLACE ไม่ drop privileges แต่ระบุไว้ชัดเพื่อ audit trail)
grant select on public.v_follow_up_stats_90d to authenticated;
grant select on public.v_follow_up_stats_90d to service_role;

-- ============================================================================
-- SECTION 6: Verify checklist สำหรับครีม (รันหลัง apply — not executed here)
-- ============================================================================

-- 5a) ตรวจ CHECK constraint ชื่อและค่าใหม่:
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.follow_ups'::regclass
--    AND contype = 'c'
--    AND conname LIKE '%follow_up_result%';
-- expected: เห็น 'line_pending' ในรายการค่า

-- 5b) ตรวจ queue_case_seen service_role access:
-- SELECT has_table_privilege('service_role', 'public.queue_case_seen', 'SELECT'); -- true
-- SELECT has_table_privilege('service_role', 'public.queue_case_seen', 'INSERT'); -- true

-- 5c) ตรวจ inbox_pins service_role access:
-- SELECT has_table_privilege('service_role', 'public.inbox_pins', 'SELECT');      -- true
-- SELECT has_table_privilege('service_role', 'public.inbox_pins', 'DELETE');      -- true

-- 5d) ตรวจ triggers บน follow_ups (ต้องครบ 4 trigger):
-- SELECT tgname, tgenabled
--   FROM pg_trigger
--  WHERE tgrelid = 'public.follow_ups'::regclass
--  ORDER BY tgname;
-- expected: trg_enforce_contact_compliance / trg_set_follow_up_author_name / trg_sync_promise_to_pay
-- (ยัง 3 ตัวเหมือนเดิม — 0047 ไม่ได้เพิ่ม trigger ใหม่)

-- 5e) Smoke: line_pending ผ่าน trigger (enforce_contact_compliance ต้องไม่ raise):
-- INSERT INTO public.follow_ups
--   (contract_id, author_id, note_text, contact_method, follow_up_result)
-- VALUES ('<test-contract-id>', auth.uid(), 'ลูกค้าทักเข้า Line', 'line', 'line_pending');
-- expected: INSERT สำเร็จ ไม่มี P0001 error แม้จะ DNC=true หรือนอกเวลา

-- 5f) ตรวจ v_follow_up_stats_90d นับ line_pending เป็น successful_attempts:
-- (หลัง insert follow_up line_pending ข้างบนแล้ว)
-- SELECT total_attempts, successful_attempts, last_result
--   FROM public.v_follow_up_stats_90d
--  WHERE contract_id = '<test-contract-id>';
-- expected: successful_attempts เพิ่มขึ้น 1, last_result = 'line_pending'

-- 5g) ตรวจ trigger touch_queue_case_seen refresh last_seen_at ทุก upsert:
-- INSERT INTO public.queue_case_seen (freelancer_id, contract_id)
--   VALUES (auth.uid(), '<test-contract-id>');               -- first insert
-- SELECT last_seen_at FROM public.queue_case_seen
--  WHERE freelancer_id = auth.uid() AND contract_id = '<test-contract-id>';  -- บันทึก ts1
-- -- รอ 1 วินาที แล้ว upsert อีกครั้ง:
-- INSERT INTO public.queue_case_seen (freelancer_id, contract_id)
--   VALUES (auth.uid(), '<test-contract-id>')
--   ON CONFLICT (freelancer_id, contract_id) DO UPDATE SET freelancer_id = EXCLUDED.freelancer_id;
-- SELECT last_seen_at FROM public.queue_case_seen
--  WHERE freelancer_id = auth.uid() AND contract_id = '<test-contract-id>';  -- ต้อง > ts1
