-- 0020: เพิ่ม promise_to_pay_date + promised_amount + trigger sync สำหรับ Priority Queue + Follow-up Worklist

-- ============================================================================
-- SECTION 1: Additive columns
-- ============================================================================

-- contracts: denormalized promise state สำหรับ sort/filter ที่ Queue
alter table public.contracts
  add column if not exists promise_to_pay_date date,
  add column if not exists promised_amount      numeric;

-- follow_ups: audit trail ยอดที่สัญญาไว้ต่อครั้ง (Pete decision #6)
alter table public.follow_ups
  add column if not exists promised_amount numeric;

-- ============================================================================
-- SECTION 2: SECURITY DEFINER trigger — sync latest promise onto contracts
-- ============================================================================
-- AFTER INSERT บน follow_ups → ถ้า result='promised' AND next_follow_up_at not null
-- → update contracts.promise_to_pay_date + promised_amount (latest-promise-wins)
--
-- เหตุที่ต้อง SECURITY DEFINER:
--   freelancer role ไม่มี contracts_write RLS → ถ้า trigger รันเป็น INVOKER
--   จะเจอ permission denied ตอนทำ UPDATE contracts
--
-- หมายเหตุ: trigger นี้เป็น AFTER INSERT เพื่อให้ BEFORE triggers ทำงานก่อน:
--   ลำดับ: trg_enforce_contact_compliance (BEFORE) → trg_set_follow_up_author_name (BEFORE)
--          → INSERT → trg_sync_promise_to_pay (AFTER)
--   ชื่อ trigger ขึ้นต้น 't' < 'trg_e' < 'trg_s' ในตัวอักษร แต่
--   BEFORE ทำงานก่อน AFTER เสมอโดย type — AFTER type = fire หลัง row insert เสร็จ
--
-- หมายเหตุ: next_follow_up_at เป็น timestamptz → cast → date ต้องแปลงเป็น Bangkok
--   เพื่อกัน off-by-one (Supabase session timezone = UTC)
--   สอดคล้องกับ 0019 ที่ใช้ 'Asia/Bangkok' ทุกที่

create or replace function public.sync_promise_to_pay()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.follow_up_result = 'promised' and new.next_follow_up_at is not null then
    update public.contracts
       set promise_to_pay_date = (new.next_follow_up_at at time zone 'Asia/Bangkok')::date,
           promised_amount     = new.promised_amount
     where id = new.contract_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_promise_to_pay on public.follow_ups;
create trigger trg_sync_promise_to_pay
  after insert on public.follow_ups
  for each row execute function public.sync_promise_to_pay();

-- ============================================================================
-- SECTION 3: Aggregate view — v_follow_up_stats_90d
-- ============================================================================
-- สำหรับ getEscalateContracts() — PostgREST caps raw table scans (default 1000 rows)
-- การ GROUP BY ใน SQL ก่อน return ป้องกัน truncation + ย้าย "success" definition ไว้ที่เดียว
--
-- successfulAttempts definition ตาม priorityQueue.ts line 17:
--   result ∈ {'contacted','promised','paid','returned','other'}
--   ไม่นับ 'no_answer', 'refused', NULL
--
-- security_invoker=on: view query รันด้วย permissions ของ caller → RLS follow_ups_read apply
-- (admin + staff ดูได้ทุก contract; freelancer ดูได้เฉพาะ in-grade contracts)
-- ดังนั้น getEscalateContracts() ที่เรียกโดย admin จะเห็นทุก contract ตามที่ต้องการ

drop view if exists public.v_follow_up_stats_90d;

create view public.v_follow_up_stats_90d
  with (security_invoker = on) as
select
  f.contract_id,
  count(*)::int                                                       as total_attempts,
  count(*) filter (
    where f.follow_up_result in ('contacted','promised','paid','returned','other')
  )::int                                                              as successful_attempts,
  max(f.created_at)                                                   as last_contacted_at,
  -- last_result: ผล ณ created_at ล่าสุด (ใช้ DISTINCT ON trick ผ่าน max+filter ไม่ได้ → sub-select ใช้ FIRST_VALUE)
  (array_agg(f.follow_up_result order by f.created_at desc))[1]       as last_result
from public.follow_ups f
where f.created_at >= now() - interval '90 days'
group by f.contract_id;

-- Grant: ใช้ pattern เดิมจาก 0018 (follow_ups grant)
grant select on public.v_follow_up_stats_90d to authenticated;
grant select on public.v_follow_up_stats_90d to service_role;

-- ============================================================================
-- SECTION 4: Index verification note
-- ============================================================================
-- existing follow_ups_contract_idx on (contract_id, created_at desc) — สร้างใน 0018
-- ครอบ query ใน getFreelancerQueue aggregate (contract_id IN (...), gte created_at)
-- ไม่ต้องสร้าง index ใหม่สำหรับ ESCALATE list หรือ warmth aggregate

-- ============================================================================
-- SECTION 4: RLS note — ไม่ต้องเพิ่ม policy ใหม่
-- ============================================================================
-- promise_to_pay_date + promised_amount เป็น columns บน contracts
-- contracts_read policy ใน 0018 (row-level) ครอบ column ใหม่อัตโนมัติ
-- freelancer อ่านได้ผ่าน policy เดิม (column-level access ไม่ใช่ row-level)
-- contracts_write ยังบล็อก freelancer write ตรงๆ — trigger SECURITY DEFINER ข้าม RLS เพื่อ sync

-- ============================================================================
-- SECTION 5: GRANTs — ไม่ต้องเพิ่ม
-- ============================================================================
-- columns ใหม่บน contracts + follow_ups ไม่ต้องการ GRANT แยก
-- table-level GRANTs ที่มีอยู่ใน 0017 (ALTER DEFAULT PRIVILEGES) + 0018 ครอบแล้ว

-- ============================================================================
-- SECTION 6: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 6a) ตรวจ column มีอยู่:
-- SELECT has_column_privilege('authenticated', 'public.contracts', 'promise_to_pay_date', 'SELECT');
--   expected: true
-- SELECT has_column_privilege('authenticated', 'public.contracts', 'promised_amount', 'SELECT');
--   expected: true
-- SELECT has_column_privilege('authenticated', 'public.follow_ups', 'promised_amount', 'SELECT');
--   expected: true

-- 6b) ตรวจ trigger ลำดับบน follow_ups (ควรเห็น trg_enforce_contact_compliance + trg_set_follow_up_author_name + trg_sync_promise_to_pay):
-- SELECT tgname, tgtype, tgenabled
--   FROM pg_trigger
--  WHERE tgrelid = 'public.follow_ups'::regclass
--  ORDER BY tgname;
-- expected rows (ชื่อเรียง):
--   trg_enforce_contact_compliance  (BEFORE INSERT row-level — type bit 7 = 7 = ROW+BEFORE+INSERT)
--   trg_set_follow_up_author_name   (BEFORE INSERT row-level)
--   trg_sync_promise_to_pay         (AFTER  INSERT row-level)

-- 6c) trigger fire probe (ใช้ test contract id จริง):
-- INSERT INTO public.follow_ups (contract_id, author_id, note_text, follow_up_result, next_follow_up_at, promised_amount)
--   VALUES ('<test-contract-id>', auth.uid(), 'ทดสอบ trigger sync', 'promised', '2026-06-25 12:00+07', 5000);
-- SELECT promise_to_pay_date, promised_amount FROM public.contracts WHERE id = '<test-contract-id>';
--   expected: promise_to_pay_date = '2026-06-25', promised_amount = 5000

-- 6d) service_role access (ควร true — inherited จาก 0017 ALTER DEFAULT PRIVILEGES):
-- SELECT has_table_privilege('service_role', 'public.contracts', 'SELECT');
--   expected: true
-- SELECT has_table_privilege('service_role', 'public.follow_ups', 'SELECT');
--   expected: true
