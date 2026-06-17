-- 0019: บังคับกฎการติดต่อตาม พ.ร.บ. ทวงถามหนี้ 2558 (Contact-Hour Enforcement + Daily Cap + Status Flags)
-- Pete decisions locked: admin exempt / daily cap per-contract / no_answer ไม่นับ cap /
--   disputed = display badge เฉยๆ / DNC = lock+banner / lawyer = block insert /
--   admin+staff ตั้งธง / admin เท่านั้นปลด / วันหยุดราชการ = 08:00-18:00

-- ============================================================================
-- SECTION 1: Status flags บน contracts (additive — add column if not exists)
-- ============================================================================

alter table public.contracts
  add column if not exists dnc              boolean not null default false,
  add column if not exists dnc_reason       text,
  add column if not exists lawyer_engaged   boolean not null default false,
  add column if not exists lawyer_name      text,
  add column if not exists lawyer_phone     text,
  add column if not exists lawyer_engaged_at date,
  add column if not exists disputed         boolean not null default false,
  add column if not exists disputed_since   date;
-- หมายเหตุ: ไม่มี disputed_resolved_at — disputed=false = clear (display flag เฉยๆ)

-- ============================================================================
-- SECTION 2: ตารางวันหยุดราชการ + seed 2026
-- ============================================================================

create table if not exists public.public_holidays (
  date date primary key,
  name text not null
);

alter table public.public_holidays enable row level security;

-- RLS: ทุก authenticated อ่านได้ (ต้องใช้ใน can_contact_at calc), admin เท่านั้นเขียน
-- ใช้ pattern เดียวกับ app_settings/shops ใน 0001 (not auth.role() = 'authenticated')
drop policy if exists holidays_read_all   on public.public_holidays;
drop policy if exists holidays_write_admin on public.public_holidays;

create policy holidays_read_all on public.public_holidays
  for select to authenticated using (true);

create policy holidays_write_admin on public.public_holidays
  for all to authenticated
  using    (is_admin())
  with check (is_admin());

-- Service role explicit (belt-and-suspenders; 0017 default privileges ครอบอยู่แล้ว)
grant select, insert, update, delete on public.public_holidays to service_role;
grant select on public.public_holidays to authenticated;

-- Seed: วันหยุดนักขัตฤกษ์ไทย 2026
-- TODO: verify กับกรมสวัสดิการฯ — อาจมีวันหยุดชดเชย/พิเศษเพิ่ม
insert into public.public_holidays (date, name) values
  ('2026-01-01', 'วันขึ้นปีใหม่'),
  ('2026-01-02', 'วันหยุดชดเชยวันสิ้นปี'),
  ('2026-02-03', 'วันมาฆบูชา'),
  ('2026-04-06', 'วันจักรี'),
  ('2026-04-13', 'วันสงกรานต์'),
  ('2026-04-14', 'วันสงกรานต์'),
  ('2026-04-15', 'วันสงกรานต์'),
  ('2026-05-01', 'วันแรงงาน'),
  ('2026-05-04', 'วันฉัตรมงคล'),
  ('2026-05-31', 'วันวิสาขบูชา'),
  ('2026-06-01', 'วันหยุดชดเชยวันวิสาขบูชา'),
  ('2026-06-03', 'วันเฉลิมพระชนมพรรษาพระราชินี'),
  ('2026-07-28', 'วันเฉลิมพระชนมพรรษา ร.10'),
  ('2026-07-29', 'วันอาสาฬหบูชา'),
  ('2026-07-30', 'วันเข้าพรรษา'),
  ('2026-08-12', 'วันแม่แห่งชาติ'),
  ('2026-10-13', 'วันคล้ายวันสวรรคต ร.9'),
  ('2026-10-23', 'วันปิยมหาราช'),
  ('2026-12-05', 'วันพ่อแห่งชาติ'),
  ('2026-12-10', 'วันรัฐธรรมนูญ'),
  ('2026-12-31', 'วันสิ้นปี')
on conflict (date) do nothing;

-- ============================================================================
-- SECTION 3: Kill-switch ใน app_settings
-- value column เป็น text (ดู 0001) — ใช้ plain 'true' ไม่ใช่ ::jsonb
-- ============================================================================

insert into public.app_settings (key, value, description) values
  ('contact_enforcement_enabled', 'true', 'เปิด/ปิดการบังคับกฎติดต่อ พ.ร.บ. ทวงถามหนี้ (true/false)')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 4: Helper function — can_contact_at(contract_id, ts)
-- returns null = OK; non-null = block code: OUTSIDE_HOURS | DAILY_CAP | DNC | LAWYER
-- รับ ts เป็น parameter เพื่อทดสอบได้ (ไม่ hardcode now())
-- security definer เพื่อให้ freelancer role อ่าน contracts + follow_ups ได้
-- ============================================================================

create or replace function public.can_contact_at(
  p_contract_id uuid,
  p_ts          timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_dow        int;
  v_is_holiday boolean;
  v_minutes    int;
  v_upper      int;
  v_dnc        boolean;
  v_lawyer     boolean;
  v_bkk_date   date;
  v_count      int;
begin
  -- Bangkok wall-clock
  v_dow      := extract(dow from (p_ts at time zone 'Asia/Bangkok'))::int;
               -- 0=Sun 6=Sat
  v_minutes  := ( extract(hour   from (p_ts at time zone 'Asia/Bangkok'))::int * 60
                + extract(minute from (p_ts at time zone 'Asia/Bangkok'))::int );
  v_bkk_date := (p_ts at time zone 'Asia/Bangkok')::date;

  select exists(
    select 1 from public.public_holidays where date = v_bkk_date
  ) into v_is_holiday;

  -- ก่อน 08:00 → block เสมอ
  if v_minutes < 480 then return 'OUTSIDE_HOURS'; end if;

  -- เพดานบน: วันหยุดราชการ/เสาร์-อา = 18:00, วันธรรมดา = 20:00
  if v_dow in (0, 6) or v_is_holiday then
    v_upper := 1080;  -- 18:00
  else
    v_upper := 1200;  -- 20:00
  end if;

  if v_minutes >= v_upper then return 'OUTSIDE_HOURS'; end if;

  -- ตรวจ flag DNC + lawyer
  select c.dnc, c.lawyer_engaged
    into v_dnc, v_lawyer
    from public.contracts c
   where c.id = p_contract_id;

  if not found then return 'OUTSIDE_HOURS'; end if;  -- สัญญาไม่มีอยู่ → กัน

  if v_dnc    then return 'DNC';    end if;
  if v_lawyer then return 'LAWYER'; end if;

  -- Daily cap per-contract (Bangkok day)
  -- Pete decision #1: no_answer ไม่นับ cap
  -- null-safe: ใช้ is distinct from แทน <> เพื่อกัน NULL hole
  -- (follow_up_result nullable — NULL is distinct from 'no_answer' → นับ)
  select count(*)::int into v_count
  from public.follow_ups f
  where f.contract_id = p_contract_id
    and f.follow_up_result is distinct from 'no_answer'
    and f.created_at >= (v_bkk_date::timestamp at time zone 'Asia/Bangkok')
    and f.created_at <  ((v_bkk_date + 1)::timestamp at time zone 'Asia/Bangkok');
  -- sargable range บน created_at → index-friendly

  if v_count >= 1 then return 'DAILY_CAP'; end if;

  return null;  -- OK ติดต่อได้
end;
$$;

-- Fix #2: REVOKE from PUBLIC + anon + authenticated
-- Vanilla Postgres: EXECUTE ถูก grant ให้ PUBLIC by default
-- Supabase: ALTER DEFAULT PRIVILEGES bootstrap อาจ grant EXECUTE ให้ anon/authenticated ด้วย (ดู 0017 pattern)
-- → revoke ทั้งสามชั้นกัน both paths; revoke role ที่ไม่มี grant เป็น no-op warning ไม่ error
-- SECURITY DEFINER trigger รันในฐานะ owner ไม่กระทบจาก revoke นี้
revoke execute on function public.can_contact_at(uuid, timestamptz) from public, anon, authenticated;
grant  execute on function public.can_contact_at(uuid, timestamptz) to service_role;

-- ============================================================================
-- SECTION 5: Index สำหรับ daily cap lookup
-- cap query ใช้ "is distinct from 'no_answer'" ซึ่งรับ NULL ด้วย
-- partial index ที่ exclude NULL จะไม่ match predicate นั้น → planner ไม่ใช้
-- follow_ups_contract_idx (contract_id, created_at desc) ใน 0018 ครอบ query ได้พอดี
-- → ไม่ต้องสร้าง index ใหม่ที่นี่
-- ============================================================================

-- ลบ index เก่าถ้าเคยสร้างชื่อนี้จากรอบ dev (idempotent safety)
drop index if exists idx_follow_ups_contract_date;
drop index if exists idx_follow_ups_cap_lookup;

-- ============================================================================
-- SECTION 6: BEFORE INSERT trigger บน follow_ups
-- บังคับกฎ PDPA ก่อน insert ทุกครั้ง (admin exempt)
-- NOTE: 0018 มี trg_set_follow_up_author_name BEFORE INSERT ด้วย — fire order:
--       enforce (0019) → author_name (0018) ตามลำดับ alphabet ใน trigger name
--       enforce ไม่ต้องใช้ author_name จึงปลอดภัย
-- ============================================================================

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
  -- Kill-switch (อ่าน text column — value เป็น text ไม่ใช่ boolean/jsonb)
  -- Fix #3: ใช้ equality เพื่อกัน cast throw ถ้า admin พิมพ์ค่าผิด (เช่น 'yes','enabled')
  -- fail-safe: coalesce → 'true' หมายความว่า row หาย = enforcement ON
  -- <> 'false' = enforcement ปิดเฉพาะเมื่อพิมพ์ 'false' ตรงๆ (PDPA legal ควร fail-safe)
  select coalesce(value, 'true') <> 'false' into v_enabled
  from public.app_settings
  where key = 'contact_enforcement_enabled';

  if v_enabled is null then v_enabled := true; end if;
  if not v_enabled then return new; end if;

  -- Pete decision #5: admin ยกเว้นจาก trigger — override 24 ชม. ได้
  select role into v_caller_role
  from public.profiles
  where id = auth.uid();

  if v_caller_role = 'admin' then return new; end if;

  -- ตรวจเวลา/flag
  v_block_code := public.can_contact_at(new.contract_id, now());

  -- Fix #1: no_answer bypass DAILY_CAP (Pete decision #1) แต่ยังตรวจ OUTSIDE_HOURS/DNC/LAWYER
  -- Option B: trigger-side override — ไม่กระทบ signature ของ can_contact_at
  -- สาเหตุที่ปลอดภัย: can_contact_at ตรวจ cap เป็น check สุดท้าย
  -- → ถ้า return DAILY_CAP = ผ่าน hours+DNC+lawyer แล้ว → safe ให้ผ่านสำหรับ no_answer
  if v_block_code = 'DAILY_CAP' and new.follow_up_result = 'no_answer' then
    v_block_code := null;
  end if;

  if v_block_code is not null then
    raise exception using
      errcode = 'P0001',
      message  = v_block_code;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_contact_compliance on public.follow_ups;
create trigger trg_enforce_contact_compliance
  before insert on public.follow_ups
  for each row execute function public.enforce_contact_compliance();

-- ============================================================================
-- SECTION 7: prevent_staff_unflag — BEFORE UPDATE บน contracts
-- Pete decision #8: admin+staff ตั้งธงได้ (contracts_write ใน 0018 allow ทั้งคู่)
-- Pete decision #8: admin เท่านั้นปลด (dnc, lawyer_engaged, disputed ทุกธง)
-- Guard นี้ทำงานเสริม RLS policy contracts_write (ซึ่งอนุญาต staff update แล้ว)
-- ============================================================================

create or replace function public.prevent_staff_unflag()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller_role text;
begin
  -- ถ้าเป็น admin → อนุญาตทุกอย่าง
  if is_admin() then return new; end if;

  select role into v_caller_role
  from public.profiles
  where id = auth.uid();

  -- staff ตั้งธงได้แต่ปลดไม่ได้
  if v_caller_role = 'staff' then
    -- dnc: true→false = ปลด → block
    if old.dnc = true and new.dnc = false then
      raise exception 'permission denied: only admin can unset dnc flag';
    end if;
    -- lawyer_engaged: true→false = ปลด → block
    if old.lawyer_engaged = true and new.lawyer_engaged = false then
      raise exception 'permission denied: only admin can unset lawyer_engaged flag';
    end if;
    -- disputed: true→false = ปลด → block (admin only ตาม decision #8 general rule)
    if old.disputed = true and new.disputed = false then
      raise exception 'permission denied: only admin can unset disputed flag';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_staff_unflag on public.contracts;
create trigger trg_prevent_staff_unflag
  before update on public.contracts
  for each row execute function public.prevent_staff_unflag();

-- ============================================================================
-- SECTION 8: RLS audit — freelance ต้องอ่าน flag ใหม่ได้ (UI lock + banner)
-- contracts.dnc / lawyer_engaged / disputed เป็น column ใน contracts ซึ่ง
-- contracts_read policy ใน 0018 อนุญาต freelancer อ่านสัญญาในเกรดตัวเองได้แล้ว
-- → flag ใหม่ถูก expose โดย policy นั้นอัตโนมัติ (column-level, not row-level)
-- freelance write contracts → ถูก block โดย contracts_write policy ใน 0018
-- → ไม่ต้องเพิ่ม policy ใหม่
-- ============================================================================

-- (No policy changes needed for contracts — existing 0018 policies cover read+write scope)

-- ============================================================================
-- SECTION 9: Smoke tests (run by Cream via MCP after apply — not executed here)
-- ============================================================================
-- SELECT has_table_privilege('service_role', 'public.public_holidays', 'SELECT');
--   expected: true
--
-- Fix #2 verify — ต้องเป็น false ทั้งคู่ ถ้า true = revoke ไม่ครอบ Supabase default privileges
-- SELECT has_function_privilege('authenticated', 'public.can_contact_at(uuid,timestamptz)', 'EXECUTE');
--   expected: false
-- SELECT has_function_privilege('anon', 'public.can_contact_at(uuid,timestamptz)', 'EXECUTE');
--   expected: false
--
-- SELECT count(*) FROM public.public_holidays WHERE date >= '2026-01-01';
--   expected: 21
--
-- SELECT * FROM public.app_settings WHERE key = 'contact_enforcement_enabled';
--   expected: value = 'true'
--
-- SELECT public.can_contact_at('<TESTQ-A-id>', '2026-06-15 14:30+07'::timestamptz);
--   expected: NULL  (จ. 14:30 BKK, ในช่วงเวลา, ไม่มี flag, ยังไม่มี follow_up วันนี้)
--
-- SELECT public.can_contact_at('<TESTQ-A-id>', '2026-06-15 07:59+07'::timestamptz);
--   expected: 'OUTSIDE_HOURS'  (ก่อน 08:00)
--
-- SELECT public.can_contact_at('<TESTQ-A-id>', '2026-06-13 18:01+07'::timestamptz);
--   expected: 'OUTSIDE_HOURS'  (ส. เกิน 18:00)
--
-- UPDATE public.contracts SET dnc=true WHERE id='<TESTQ-B-id>';
-- SELECT public.can_contact_at('<TESTQ-B-id>', '2026-06-15 14:30+07'::timestamptz);
--   expected: 'DNC'
--
-- INSERT into follow_ups (contract_id, author_id, note_text, follow_up_result)
--   values ('<TESTQ-A-id>', auth.uid(), 'ทดสอบ DAILY_CAP', 'contacted');
-- SELECT public.can_contact_at('<TESTQ-A-id>', '2026-06-15 15:00+07'::timestamptz);
--   expected: 'DAILY_CAP'
--
-- INSERT follow_up with follow_up_result='no_answer' → ต้องผ่าน trigger (Fix #1 bypass DAILY_CAP)
-- SELECT public.can_contact_at('<TESTQ-A-id>', '2026-06-15 15:00+07'::timestamptz);
--   expected: 'DAILY_CAP'  (can_contact_at ยังนับ contacted row อยู่ — trigger bypass เฉยๆ ไม่ได้เปลี่ยนค่า count)
-- NOTE: trigger ยังปล่อย no_answer INSERT ผ่านได้เพราะ Fix #1 override DAILY_CAP → null ก่อน raise
