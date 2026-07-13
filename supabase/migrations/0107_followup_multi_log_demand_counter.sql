-- 0107: ปลดล็อกบันทึกติดตามหลายรอบ/วัน + ตัวนับ "การทวงลูกหนี้" (พ.ร.บ. ทวงถามหนี้ 2558)
-- Pete เคาะ: พนักงานบันทึก follow_up ได้ไม่จำกัดรอบ/วัน — แต่ระบบยังคุม พ.ร.บ. โดย "นับการทวงลูกหนี้"
--            แค่ครั้งแรกของวัน (counts_as_demand=true) ที่เหลือ = บันทึกต่อเนื่อง (false)
--
-- เปลี่ยนอะไร (เทียบพฤติกรรมเดิม 0091):
--   1) เพิ่มคอลัมน์ follow_ups.counts_as_demand (boolean not null default false)
--   2) enforce_contact_compliance(): DAILY_CAP เลิก raise (treat as pass) — บันทึกซ้ำได้ไม่จำกัด
--      แต่ยัง hard-block OUTSIDE_HOURS / DNC / LAWYER ทุกประการ (พ.ร.บ. คุมเวลา+DNC+ทนาย ไม่ใช่แค่ cap)
--      + เซ็ต NEW.counts_as_demand ก่อน return (ครั้งแรกของวันที่เข้านิยาม=true, ที่เหลือ=false)
--   3) Backfill แถวเก่า (idempotent) — ต่อ (contract × วันกรุงเทพ) แถว debtor ที่ไม่ใช่ no_answer/line_pending
--      ที่เก่าสุด → true, ที่เหลือ → false
--
-- ⚠️ additive only:
--   - add column if not exists
--   - CREATE OR REPLACE function เท่านั้น — ห้าม DROP trigger trg_enforce_contact_compliance
--     (0-arg trigger function signature ไม่เปลี่ยน → CREATE OR REPLACE ปลอดภัย ไม่ใช่ overload ใหม่
--      trigger ยังคง fire function ที่อัปเดตแล้วอัตโนมัติ)
--   - ไม่แตะ can_contact_at() เลย (คง signature 3-arg + grant เดิมจาก 0091 ไว้ทั้งหมด)
--     enforce_ แค่ "ไม่เอา DAILY_CAP ไป raise" — ไม่ต้อง regrant อะไร

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์ counts_as_demand (additive)
-- ============================================================================

alter table public.follow_ups
  add column if not exists counts_as_demand boolean not null default false;

comment on column public.follow_ups.counts_as_demand is
  'พ.ร.บ.ทวงถามหนี้ 2558: true = การบันทึกนี้ถือเป็น "การทวงลูกหนี้" ครั้งแรกของวัน (นับ 1 ครั้ง/วัน/สัญญา); false = บันทึกต่อเนื่อง/ไม่เข้านิยาม (contact_target=other, no_answer, line_pending, หรือไม่ใช่ครั้งแรกของวัน). trigger enforce_contact_compliance เซ็ตค่านี้ตอน insert';

-- ============================================================================
-- SECTION 2: enforce_contact_compliance — DAILY_CAP ไม่ raise + เซ็ต counts_as_demand
-- Reproduce จาก 0091 SECTION 3 (เวอร์ชันล่าสุด — ไม่มี migration หลัง 0091 ที่ recreate function นี้)
-- เปลี่ยน 2 จุด:
--   (A) เซ็ต NEW.counts_as_demand ก่อนทำอย่างอื่น (reporting metric — คำนวณทุกเส้นทาง แม้ bypass)
--   (B) DAILY_CAP → treat as pass (ไม่ raise) — คง OUTSIDE_HOURS / DNC / LAWYER hard-block เหมือนเดิม
-- คง bypass เดิมครบ: kill-switch / admin / line_pending
-- ห้าม DROP/RECREATE trigger — CREATE OR REPLACE function เท่านั้น
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
  v_qualifies   boolean;
begin
  -- (A) เซ็ต counts_as_demand ก่อน — เป็น "ตัวนับเชิงรายงาน" ต้องคำนวณทุกเส้นทาง
  --     (แม้ kill-switch / admin / line_pending จะ early-return ด้านล่าง ค่านี้ก็ถูกเซ็ตไว้แล้ว)
  --     นิยาม "การทวงลูกหนี้": contact_target='debtor' AND result ∉ (no_answer, line_pending)
  --     null-safe: coalesce(result,'') → null result ถือว่าไม่ใช่ no_answer/line_pending (เข้านิยาม)
  --                กัน assign NULL ลงคอลัมน์ NOT NULL
  v_qualifies := ( coalesce(new.contact_target, 'debtor') = 'debtor'
                   and coalesce(new.follow_up_result, '') not in ('no_answer', 'line_pending') );

  new.counts_as_demand := v_qualifies
    and not exists (
      select 1
      from public.follow_ups f
      where f.contract_id = new.contract_id
        and f.contact_target = 'debtor'
        and coalesce(f.follow_up_result, '') not in ('no_answer', 'line_pending')
        and f.counts_as_demand = true
        and (f.created_at at time zone 'Asia/Bangkok')::date
            = (now() at time zone 'Asia/Bangkok')::date
    );
  -- BEFORE INSERT: แถวใหม่ยังไม่ถูก insert → subquery ไม่เห็นตัวเอง; นับเฉพาะแถวที่ commit แล้ว

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

  -- (4) ตรวจเวลา/flag ด้วย can_contact_at — ส่ง contact_target เข้าไปด้วย (คงจาก 0091)
  v_block_code := public.can_contact_at(new.contract_id, now(), coalesce(new.contact_target, 'debtor'));

  -- (5) [เปลี่ยน 0107] DAILY_CAP เลิก raise — treat as pass
  --     Pete เคาะ: บันทึกติดตามได้ไม่จำกัดรอบ/วัน. การคุม พ.ร.บ. ย้ายไป "นับ" (counts_as_demand)
  --     แทนการ "บล็อก". ครอบ no_answer/other bypass เดิมของ 0091 ไปในตัว (DAILY_CAP ไม่ block ใครแล้ว)
  if v_block_code = 'DAILY_CAP' then
    v_block_code := null;
  end if;

  -- (6) block เฉพาะ OUTSIDE_HOURS / DNC / LAWYER (คง hard-block ทุกประการ)
  if v_block_code is not null then
    raise exception using
      errcode = 'P0001',
      message  = v_block_code;
  end if;

  return new;
end;
$$;

-- ไม่ recreate trigger — trg_enforce_contact_compliance ยังอ้าง function ชื่อเดิม
-- CREATE OR REPLACE function = trigger fire function ที่อัปเดตแล้วอัตโนมัติ

-- ============================================================================
-- SECTION 3: Backfill counts_as_demand ให้แถวเก่า (idempotent)
-- ต่อ (contract_id × วันกรุงเทพ): แถวที่ contact_target='debtor' AND result ∉ (no_answer,line_pending)
--   ที่ created_at เก่าสุด → true, ที่เหลือในกลุ่มเดียวกัน → false
-- แถวที่ไม่เข้านิยาม (other / no_answer / line_pending) = false (default อยู่แล้ว — ไม่แตะ)
-- idempotent: รันซ้ำได้ผลเท่าเดิม (row_number กำหนดผู้ชนะ deterministic ด้วย created_at asc, id asc)
-- ============================================================================

with ranked as (
  select
    f.id,
    row_number() over (
      partition by f.contract_id, (f.created_at at time zone 'Asia/Bangkok')::date
      order by f.created_at asc, f.id asc
    ) as rn
  from public.follow_ups f
  where f.contact_target = 'debtor'
    and coalesce(f.follow_up_result, '') not in ('no_answer', 'line_pending')
)
update public.follow_ups f
set counts_as_demand = (r.rn = 1)
from ranked r
where f.id = r.id
  and f.counts_as_demand is distinct from (r.rn = 1);   -- แตะเฉพาะแถวที่ค่าจะเปลี่ยนจริง (ลด write)

-- ============================================================================
-- SECTION 4: Verify checklist สำหรับครีม (รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 4a) คอลัมน์มีจริง + not null default false:
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='follow_ups' AND column_name='counts_as_demand';
-- expected: boolean, false, NO

-- 4b) trigger ยังอยู่ (ต้องไม่หาย):
-- SELECT tgname FROM pg_trigger WHERE tgrelid='public.follow_ups'::regclass
--   AND tgname='trg_enforce_contact_compliance';
-- expected: 1 row

-- 4c) backfill invariant — ≤1 แถว counts_as_demand=true ต่อ (contract × วันกรุงเทพ):
-- SELECT contract_id, (created_at at time zone 'Asia/Bangkok')::date AS bkk_day, count(*) AS demands
--   FROM public.follow_ups
--  WHERE counts_as_demand = true
--  GROUP BY 1, 2
-- HAVING count(*) > 1;
-- expected: 0 rows

-- 4d) ทุกแถว counts_as_demand=true ต้องเป็น debtor + result ∉ (no_answer,line_pending):
-- SELECT count(*) FROM public.follow_ups
--  WHERE counts_as_demand = true
--    AND (contact_target <> 'debtor' OR coalesce(follow_up_result,'') IN ('no_answer','line_pending'));
-- expected: 0

-- 4e) Smoke: insert 3 รอบวันเดียว สัญญาเดียว (contact_target='debtor', result='contacted') ผ่านหมด
--     แถวแรก counts_as_demand=true, แถว 2-3 = false. (ใช้ token staff/freelancer ในช่วงเวลาทำการ)
-- แถว other วันเดียวกันต้อง insert ได้เช่นกัน + counts_as_demand=false
