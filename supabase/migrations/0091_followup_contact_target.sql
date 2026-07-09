-- 0091: แยกคิวโทรหาลูกหนี้ กับโทรหาผู้ติดต่อ (ญาติ/ผู้ค้ำ) — daily cap พ.ร.บ. ทวงหนี้ 2558 นับเฉพาะการโทรลูกหนี้
-- Pete decision: Option A / Branch 1 แบบง่าย — แยกแค่ debtor vs other (ไม่แยกผู้ค้ำเป็น cap ของตัวเอง)
--   OUTSIDE_HOURS / DNC / LAWYER ยังบังคับทั้งคู่ (พ.ร.บ. คุมช่วงเวลา+DNC+lawyer ไม่ใช่แค่ cap)
--   UI warning message = งานน้องวิว (ไม่แตะที่นี่)
--
-- ⚠️ ครีมอ่านก่อน apply:
--   can_contact_at(uuid, timestamptz) เดิมจาก 0019 ไม่เคยถูกแก้ signature เลยจนถึง 0090
--   enforce_contact_compliance() เวอร์ชันล่าสุดอยู่ที่ 0047 (มี line_pending exempt) — ไฟล์นี้ reproduce
--   จาก 0047 verbatim แล้วเพิ่มเฉพาะส่วน contact_target (ไม่ใช่จาก 0019 ที่ stale แล้ว)
--
--   can_contact_at ต้องเปลี่ยนจาก 2 args → 3 args (เพิ่ม p_contact_target default 'debtor')
--   Postgres ถือว่า arg-type list ต่างกัน = คนละ overload ไม่ใช่ "replace" ตัวเดิม
--   → ต้อง DROP FUNCTION 2-arg เดิมทิ้งก่อน แล้ว CREATE ตัวใหม่ 3-arg
--   ปลอดภัย: enforce_contact_compliance() เรียก can_contact_at ผ่าน plpgsql body (เป็น text,
--   ไม่ผูก pg_depend แบบ view/rule) — DROP ไม่ error แม้ trigger function อ้างชื่อเดิมอยู่ในเนื้อ body
--   เพราะไฟล์นี้ recreate enforce_contact_compliance() ให้เรียก 3-arg ตัวใหม่ทันทีถัดจากนี้ในสคริปต์เดียวกัน
--   ไม่มี VIEW/CHECK constraint อื่นอ้าง can_contact_at → DROP ไม่ CASCADE ไม่กระทบใคร

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์ follow_ups (additive — add column if not exists)
-- ============================================================================

alter table public.follow_ups
  add column if not exists contact_target text not null default 'debtor'
    check (contact_target in ('debtor', 'other')),
  add column if not exists contact_person_name     text,
  add column if not exists contact_person_relation  text;
-- existing rows ได้ default 'debtor' อัตโนมัติ (ไม่ต้อง backfill — ปลอดภัยตามพฤติกรรมเดิม)

-- ============================================================================
-- SECTION 2: can_contact_at — DROP 2-arg เดิม + CREATE 3-arg ใหม่
-- เพิ่ม p_contact_target text default 'debtor'
--   (a) DAILY_CAP count query: นับเฉพาะแถวที่ contact_target='debtor' (นับเฉพาะการโทรลูกหนี้จริง —
--       โทรหาผู้ติดต่อไม่กินโควตาลูกหนี้ ไม่ว่าใครเป็นคนเช็ค)
--   (b) DAILY_CAP ผลลัพธ์: return 'DAILY_CAP' เฉพาะตอนที่ p_contact_target='debtor' เท่านั้น
--       (ชั้นแรกของ 2-layer defense — ชั้นสองอยู่ใน enforce_contact_compliance ด้านล่าง)
-- ============================================================================

drop function if exists public.can_contact_at(uuid, timestamptz);

create or replace function public.can_contact_at(
  p_contract_id     uuid,
  p_ts              timestamptz,
  p_contact_target  text default 'debtor'  -- 0091: 'debtor' | 'other'
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

  -- ก่อน 08:00 → block เสมอ (ทั้ง debtor และ other — พ.ร.บ. คุมช่วงเวลาไม่แยกเป้าหมาย)
  if v_minutes < 480 then return 'OUTSIDE_HOURS'; end if;

  -- เพดานบน: วันหยุดราชการ/เสาร์-อา = 18:00, วันธรรมดา = 20:00
  if v_dow in (0, 6) or v_is_holiday then
    v_upper := 1080;  -- 18:00
  else
    v_upper := 1200;  -- 20:00
  end if;

  if v_minutes >= v_upper then return 'OUTSIDE_HOURS'; end if;

  -- ตรวจ flag DNC + lawyer (ทั้ง debtor และ other — ยังบังคับตามเดิม ตาม Pete decision)
  select c.dnc, c.lawyer_engaged
    into v_dnc, v_lawyer
    from public.contracts c
   where c.id = p_contract_id;

  if not found then return 'OUTSIDE_HOURS'; end if;  -- สัญญาไม่มีอยู่ → กัน

  if v_dnc    then return 'DNC';    end if;
  if v_lawyer then return 'LAWYER'; end if;

  -- Daily cap per-contract (Bangkok day)
  -- Pete decision (0019 #1): no_answer ไม่นับ cap
  -- 0091: นับเฉพาะแถวที่ contact_target='debtor' — โทรหาผู้ติดต่อ(ญาติ/ผู้ค้ำ) ไม่กินโควตาลูกหนี้
  -- null-safe: ใช้ is distinct from แทน <> เพื่อกัน NULL hole
  select count(*)::int into v_count
  from public.follow_ups f
  where f.contract_id = p_contract_id
    and f.contact_target = 'debtor'
    and f.follow_up_result is distinct from 'no_answer'
    and f.created_at >= (v_bkk_date::timestamp at time zone 'Asia/Bangkok')
    and f.created_at <  ((v_bkk_date + 1)::timestamp at time zone 'Asia/Bangkok');
  -- sargable range บน created_at → index-friendly

  -- 0091: DAILY_CAP มีผลเฉพาะตอนกำลังเช็คสำหรับ 'debtor' เท่านั้น
  -- (การโทรหา 'other' ไม่ควรถูกบล็อกด้วยโควตาลูกหนี้ — trigger ด้านล่างมี bypass ชั้นสองซ้ำอีกที)
  if v_count >= 1 and p_contact_target = 'debtor' then return 'DAILY_CAP'; end if;

  return null;  -- OK ติดต่อได้
end;
$$;

-- Fix #2 (จาก 0019) reproduce สำหรับ signature ใหม่: REVOKE from PUBLIC + anon + authenticated
revoke execute on function public.can_contact_at(uuid, timestamptz, text) from public, anon, authenticated;
grant  execute on function public.can_contact_at(uuid, timestamptz, text) to service_role;

-- ============================================================================
-- SECTION 3: enforce_contact_compliance — reproduce จาก 0047 (เวอร์ชันล่าสุด) verbatim
-- เพิ่มเฉพาะ: (a) ส่ง new.contact_target เข้า can_contact_at
--            (b) bypass DAILY_CAP ชั้นสองเมื่อ new.contact_target='other'
--                (style เดียวกับ no_answer bypass เดิม — belt-and-suspenders คู่กับ SECTION 2(b))
-- ลำดับ invariant (คงทุกอย่างจาก 0047):
--   (1) kill-switch → (2) admin exempt → (3) line_pending exempt → (4) can_contact_at
--   → (5) no_answer bypass DAILY_CAP → (5b) other-target bypass DAILY_CAP [NEW] → (6) block/pass
--
-- ห้าม DROP/RECREATE trigger trg_enforce_contact_compliance — ใช้ CREATE OR REPLACE function เท่านั้น
-- (0-arg trigger function signature ไม่เปลี่ยน → CREATE OR REPLACE ปลอดภัย ไม่ใช่ overload ใหม่)
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
  -- (1) Kill-switch
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

  -- (3) line_pending exempt (0047) — ลูกค้า initiate ผ่าน Line (inbound)
  if new.follow_up_result = 'line_pending' then return new; end if;

  -- (4) ตรวจเวลา/flag ด้วย can_contact_at — ส่ง contact_target เข้าไปด้วย (0091)
  -- new.contact_target มี NOT NULL DEFAULT 'debtor' อยู่แล้ว (SECTION 1) — coalesce กันไว้อีกชั้น
  v_block_code := public.can_contact_at(new.contract_id, now(), coalesce(new.contact_target, 'debtor'));

  -- (5) no_answer bypass DAILY_CAP (Pete decision #1 จาก 0019, Fix #1)
  if v_block_code = 'DAILY_CAP' and new.follow_up_result = 'no_answer' then
    v_block_code := null;
  end if;

  -- (5b) contact_target='other' bypass DAILY_CAP [NEW 0091]
  -- Pete decision (Option A แบบง่าย): โทรหาผู้ติดต่อ(ญาติ/ผู้ค้ำ) ไม่กินโควตาลูกหนี้
  -- can_contact_at เองก็ gate ด้วย p_contact_target อยู่แล้ว (SECTION 2(b), ชั้นแรก)
  -- override ตรงนี้เป็นชั้นสอง (belt-and-suspenders) เผื่ออนาคตมีจุดเรียก can_contact_at อื่น
  -- ที่ไม่ได้ส่ง contact_target เข้าไป — ยังบังคับ OUTSIDE_HOURS / DNC / LAWYER ตามเดิมเสมอ
  if v_block_code = 'DAILY_CAP' and new.contact_target = 'other' then
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

-- ไม่ recreate trigger — trg_enforce_contact_compliance ยังอ้าง function เดิมชื่อเดิม
-- CREATE OR REPLACE function = trigger ยังคง fire function ที่อัปเดตแล้วอัตโนมัติ

-- ============================================================================
-- SECTION 4: CREATE OR REPLACE v_follow_up_stats_90d — successful_attempts นับเฉพาะ debtor
-- ============================================================================
-- ติ๊ก review เจอ RED (Wave 2 follow-up): view เดิม (0047 SECTION 5) นับ successful_attempts
-- จากทุก contact_target โดยไม่แยก → โทรหาผู้ติดต่อ (other) ที่ "ติดต่อสำเร็จ" ก็ทำให้
-- successful_attempts > 0 ได้ทั้งที่ยังไม่เคยถึงตัวลูกหนี้เลย → เคสหลุดจาก ESCALATE
-- (getEscalateContracts db.ts: total_attempts>=10 AND successful_attempts=0) ทั้งที่ควรติด
-- ESCALATE อยู่ (นี่คือบั๊กแบบเดียวกับที่ 0091 ตั้งใจกัน แต่หลุดคนละทาง — ครั้งนี้ทาง "นับเกิน"
-- แทนที่จะเป็น "บล็อกเกิน")
--
-- Reproduce จาก 0047 SECTION 5 (เวอร์ชันล่าสุด — verify แล้วไม่มี migration หลัง 0047 ที่
-- recreate view นี้อีกจนถึง 0090) verbatim แล้วเปลี่ยนเฉพาะ 1 จุด:
--   successful_attempts filter เพิ่ม `and f.contact_target = 'debtor'`
--   → "ติดต่อสำเร็จ" ต้องหมายถึงถึงตัวลูกหนี้เท่านั้น โทรหาญาติ/ผู้ค้ำ (other) ไม่นับ
--
-- total_attempts / last_contacted_at / last_result: คงเดิมทุกจุด (ไม่ดู contact_target)
--   — total_attempts ยังนับทุกแถวรวมโทรญาติ (พยายามโทรกี่ครั้งก็นับ)
--   — ESCALATE ที่ถูกต้อง = โทร≥10 ครั้ง แต่ไม่เคยถึงตัวลูกหนี้เลย (แม้จะเคยถึงญาติ)
--
-- Column set ไม่เปลี่ยน (เหมือน 0047): contract_id | total_attempts | successful_attempts
--   | last_contacted_at | last_result
-- getInboxCases() (db.ts) ใช้แค่ last_result='line_pending' — ไม่แตะ successful_attempts
--   → ไม่ regress (line_pending มาจาก inbound ของลูกหนี้เองอยู่แล้ว ไม่ผ่าน contact_target='other')
--
-- contact_target มี NOT NULL DEFAULT 'debtor' จาก SECTION 1 ของไฟล์นี้ (รันมาก่อนหน้านี้แล้ว
-- ในสคริปต์เดียวกัน) → แถวเก่าก่อน 0091 ทั้งหมดได้ default 'debtor' อัตโนมัติ ปลอดภัย ไม่ต้อง backfill

create or replace view public.v_follow_up_stats_90d
  with (security_invoker = on) as
select
  f.contract_id,
  count(*)::int                                                       as total_attempts,
  count(*) filter (
    where f.follow_up_result in ('contacted','promised','paid','returned','other','line_pending')
      and f.contact_target = 'debtor'   -- 0091: "สำเร็จ" ต้องถึงตัวลูกหนี้ โทรหาญาติ/ผู้ค้ำไม่นับ
  )::int                                                              as successful_attempts,
  max(f.created_at)                                                   as last_contacted_at,
  -- last_result: ผล ณ created_at ล่าสุด (คงเดิม — ไม่ดู contact_target)
  (array_agg(f.follow_up_result order by f.created_at desc))[1]       as last_result
from public.follow_ups f
where f.created_at >= now() - interval '90 days'
group by f.contract_id;

-- grant ซ้ำ (idempotent — reproduce จาก 0047 เพื่อ audit trail; CREATE OR REPLACE ไม่ drop privileges)
grant select on public.v_follow_up_stats_90d to authenticated;
grant select on public.v_follow_up_stats_90d to service_role;

-- ============================================================================
-- SECTION 5: Verify checklist สำหรับครีม (รันหลัง apply — not executed here)
-- ============================================================================

-- 5a) ตรวจคอลัมน์ใหม่:
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='follow_ups'
--    AND column_name IN ('contact_target','contact_person_name','contact_person_relation');
-- expected: contact_target not null default 'debtor'::text; อีก 2 คอลัมน์ nullable text

-- 5b) ตรวจ signature ใหม่ของ can_contact_at (ต้องเหลือแค่ 3-arg ตัวเดียว ไม่มี 2-arg ตกค้าง):
-- SELECT p.oid::regprocedure
--   FROM pg_proc p
--  WHERE p.proname = 'can_contact_at' AND p.pronamespace = 'public'::regnamespace;
-- expected: 1 row = can_contact_at(uuid, timestamptz, text)

-- 5c) ตรวจ execute privilege บน signature ใหม่ (ต้อง false ทั้งคู่):
-- SELECT has_function_privilege('authenticated', 'public.can_contact_at(uuid,timestamptz,text)', 'EXECUTE');
-- SELECT has_function_privilege('anon', 'public.can_contact_at(uuid,timestamptz,text)', 'EXECUTE');

-- 5d) Smoke — DAILY_CAP นับเฉพาะ debtor:
-- INSERT INTO follow_ups (contract_id, author_id, note_text, follow_up_result, contact_target)
--   VALUES ('<TESTQ-A-id>', auth.uid(), 'โทรลูกหนี้ครั้งที่ 1', 'contacted', 'debtor');
-- SELECT public.can_contact_at('<TESTQ-A-id>', now(), 'debtor');
--   expected: 'DAILY_CAP'
-- SELECT public.can_contact_at('<TESTQ-A-id>', now(), 'other');
--   expected: NULL (ไม่โดน cap ของ debtor)
-- INSERT INTO follow_ups (contract_id, author_id, note_text, follow_up_result, contact_target,
--                          contact_person_name, contact_person_relation)
--   VALUES ('<TESTQ-A-id>', auth.uid(), 'โทรหาแม่ลูกหนี้', 'contacted', 'other', 'คุณแม่', 'มารดา');
--   expected: INSERT สำเร็จ (ไม่โดน P0001 DAILY_CAP แม้ debtor โดน cap ไปแล้วข้างบน)
-- SELECT public.can_contact_at('<TESTQ-A-id>', now(), 'debtor');
--   expected: 'DAILY_CAP' (ยังคงเดิม — แถว 'other' ไม่ถูกนับเข้า cap ของ debtor)

-- 5e) ตรวจ v_follow_up_stats_90d.successful_attempts นับเฉพาะ contact_target='debtor' (ติ๊ก RED fix):
-- ใช้คู่สัญญาเดิมจาก 5d (โทรลูกหนี้ 1 ครั้ง contacted + โทรหาแม่ 1 ครั้ง contacted = 2 total_attempts)
-- SELECT contract_id, total_attempts, successful_attempts, last_result
--   FROM public.v_follow_up_stats_90d WHERE contract_id = '<TESTQ-A-id>';
--   expected: total_attempts = 2, successful_attempts = 1 (นับแค่แถว debtor), last_result = 'contacted'
--   (ก่อนแก้: successful_attempts จะเป็น 2 — ทั้งแถว debtor และ other ถูกนับรวม = บั๊กที่ SECTION 4 แก้)

-- 5f) Smoke ตรง ESCALATE rule (getEscalateContracts: total_attempts>=10 AND successful_attempts=0):
-- สัญญาที่โทรหาญาติสำเร็จหลายครั้งแต่ไม่เคยถึงตัวลูกหนี้เลย ≥10 ครั้ง ต้องยังติด ESCALATE
-- INSERT ... contact_target='other', follow_up_result='contacted' ซ้ำ 10 ครั้งกับสัญญาทดสอบใหม่
-- SELECT total_attempts, successful_attempts FROM public.v_follow_up_stats_90d WHERE contract_id = '<test-id>';
--   expected: total_attempts = 10, successful_attempts = 0 → ผ่านเงื่อนไข ESCALATE (ก่อนแก้จะหลุด)
