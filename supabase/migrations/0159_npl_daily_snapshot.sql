-- 0159: ประวัติหนี้เสียรายวัน (ล่าช้า ≥ 60 วัน) สำหรับหน้า /monthly-report — เลือกช่วงวันที่ย้อนหลังดูได้
-- ────────────────────────────────────────────────────────────────────────────
-- บริบท: การ์ด kpiBadDebt60 (src/lib/monthlyReport.ts buildBucketKpi) คำนวณสด "ณ วันนี้" เท่านั้น — ไม่มีที่
-- เก็บย้อนหลัง คุณเตยอยากเลือกช่วงวันแล้วดูว่า ณ แต่ละวันมีหนี้เสียเท่าไหร่ — ไม่มีข้อมูลดิบพอจะคำนวณย้อนหลัง
-- "ที่ดึงแบบ read-model" ได้ (ตาราง installments/payment_log ถูกเขียนทับเป็นสถานะล่าสุดเสมอ ไม่ใช่ append-only
-- เต็มรูป) จึงต้องมี (1) ฟังก์ชันคำนวณ as-of วันใดก็ได้จากข้อมูลปัจจุบัน + เงินที่จ่ายหลังวันนั้น (หักออก
-- ย้อนกลับ) (2) ตาราง snapshot รายวัน (3) cron เก็บทุกคืน (4) backfill ของเก่า (ครีมรันเองนอกไฟล์นี้ — เสี่ยง
-- timeout ถ้าใส่ loop ในนี้) (5) RPC อ่านช่วงวันที่ (คืนแถว snapshot + ต่อท้าย 1 แถวสดของวันนี้ถ้าอยู่ในช่วง)
--
-- สูตร (ก็อปมาจาก SQL ที่ครีม validate แล้วกับการ์ดจริง ณ D=2026-09-16 ตรงเป๊ะ — 2323/166/฿3,966,015):
--   active_count/bad_count/outstanding_total/bad_outstanding ของสัญญาที่ "เปิดอยู่ ณ วันนั้น" (active จริง,
--   หรือ returned/closed ที่ปิดหลังวันนั้น) — bad = days_late >= 60 (นับจากงวดค้างเก่าสุด, ยกเว้น
--   pending_documents=true ถือว่า 0 — ตรงกับ v_contract_status/buildBucketKpi) — มูลค่า = ยอดคงเหลือทั้งสัญญา
--   (v_contract_aggregates concept: Σ installments.amount ที่ยังไม่ปิด หักด้วยเงินที่จ่ายไปแล้ว ณ วันนั้น)
--
-- กับดักที่เจอระหว่าง validate (อย่าแก้กลับ):
--   - correlated subquery ต่อแถว = statement timeout บนสัญญา 2,300+ แถว → ต้อง pre-aggregate เป็น CTE
--     (la_inst/la_con) ก่อนแล้ว join กลับ ไม่ใช้ subquery ต่อแถว
--   - payment_log ของสัญญา closed บางตัวมี created_at เป็น "อนาคต" (placeholder ตอน import ก่อนสัญญาปิด) —
--     ต้องกันด้วย fut CTE (ld > วันนี้จริง ไม่ใช่ > p_date) ไม่งั้นสัญญาปิดพวกนี้จะถูกนับเป็น "เปิดอยู่" ผิด
--   - ต้องหักเงินที่จ่ายหลัง p_date ออกจากยอดคงเหลือย้อนหลัง (la_inst) ไม่งั้นงวดที่จ่ายไปแล้วหลัง p_date จะ
--     กลายเป็น "จ่ายแล้ว" ตั้งแต่ก่อน p_date ด้วย (ยอดหนี้เสียหายไปหลายล้านบาทถ้าลืมจุดนี้)
--   - "วันนี้" ในฟังก์ชันใช้ (now() at time zone 'Asia/Bangkok')::date เสมอ — ห้ามใช้ current_date ตรงๆ
--     (เวลาเซิร์ฟเวอร์ Supabase เป็น UTC ต่างโซนเวลากับคุณเตย)
--   - device_returns คีย์ย้อนหลัง: 66 แถวถูกคีย์พร้อมกันวันที่ 21 มิ.ย. (28 แถว) และ 23 มิ.ย. (38 แถว) —
--     created_at = วันคีย์ ไม่ใช่วันคืนจริง (checked_at ว่าง, shipped_at เป็น ก.ค.) ทำให้สัญญากลุ่มนี้ถูกนับ
--     เป็น active+หนี้เสียเกินจริงก่อนหน้านั้น (16–22 มิ.ย. อัตรา 6–7% แล้วตกฮวบเหลือ 4.3% วันที่ 23) →
--     NPL_HISTORY_MIN_DATE/v_min_date เลื่อนมาเริ่ม 2026-06-24 (ตัวเลขเรียบแล้วตั้งแต่วันนี้) แทนที่จะแก้สูตร
--     ret/open_at (ข้อมูลต้นทางเพี้ยน ไม่ใช่ logic ผิด — แก้ที่ขอบเขตวันที่แทน)
--
-- เรื่อง 0157/0158 (เปลี่ยนผู้ผ่อน / cutover เลขที่ใบ PJ): ตรวจแล้ว — ฟีเจอร์นี้ "แก้ตัวตนผู้ผ่อนบนแถวสัญญาเดิม"
-- (customer_name/national_id/phone/inv_no ฯลฯ) ไม่สร้างสัญญาใหม่ ไม่เปลี่ยน status/transaction_date/
-- device_price/installments/payment_log เลย (ดู comment หัวไฟล์ 0157 บรรทัด 3-5) → open_at/inst/per ด้านบน
-- ไม่ต้องปรับอะไร สัญญาที่ถูกเปลี่ยนผู้ผ่อนยังนับเป็นสัญญาเดิม 1 แถวตลอด ไม่มีความเสี่ยงนับซ้ำ/หลุดรอบวันโอน
--
-- Additive/idempotent — create or replace function, create table if not exists, drop policy if exists ก่อน
-- สร้างใหม่, cron.unschedule ก่อน cron.schedule (pattern 0003) — ไม่ backfill loop ในไฟล์นี้ (เสี่ยง timeout,
-- คำสั่ง backfill อยู่ท้ายไฟล์เป็น comment ให้ครีมรันเองเป็น chunk)

-- ============================================================================
-- SECTION 1: ตาราง npl_daily_snapshot — เก็บผลคำนวณรายวัน (1 แถวต่อวัน)
-- ============================================================================

create table if not exists public.npl_daily_snapshot (
  snapshot_date      date primary key,
  active_count       int not null,
  bad_count          int not null,
  outstanding_total  numeric not null,
  bad_outstanding    numeric not null,
  source             text not null check (source in ('backfill', 'daily')),
  computed_at        timestamptz not null default now()
);

comment on table public.npl_daily_snapshot is
  '(0159) snapshot รายวันของหนี้เสีย (days_late>=60, สัญญา active ณ วันนั้น) — เขียนได้ทาง record_npl_snapshot() (SECURITY DEFINER, service_role เท่านั้น) เท่านั้น; อ่านผ่าน get_npl_history() เท่านั้น (ไม่เปิด policy ให้ authenticated อ่านตรงตาราง) source=backfill (คำนวณย้อนหลังครั้งเดียว) หรือ daily (cron ทุกคืน)';

-- RLS: เปิดไว้ ไม่มี policy ให้ authenticated เลย (อ่านผ่าน RPC SECURITY DEFINER เท่านั้น — pattern เดียวกับ
-- pj_applied_receipts ใน 0132 SECTION 2: table owner (postgres, ผู้สร้าง RPC) bypass RLS อยู่แล้วโดย default)
alter table public.npl_daily_snapshot enable row level security;

revoke all on public.npl_daily_snapshot from anon;
revoke all on public.npl_daily_snapshot from authenticated;

-- service_role: full (0017 ALTER DEFAULT PRIVILEGES ครอบให้แล้ว แต่ใส่ชัดๆ ไว้ด้วยตาม pattern โปรเจกต์)
grant select, insert, update, delete on public.npl_daily_snapshot to service_role;


-- ============================================================================
-- SECTION 2: npl_as_of(p_date) — คำนวณหนี้เสีย ณ วันใดก็ได้ จากข้อมูลปัจจุบัน (หักเงินที่จ่ายหลัง p_date คืน)
-- service_role เท่านั้นที่เรียกตรงได้ (ไม่มี PII แต่เป็น engine ภายใน — authenticated เรียกผ่าน get_npl_history)
-- ============================================================================

create or replace function public.npl_as_of(p_date date)
returns table (
  as_of_date         date,
  active_count       int,
  bad_count          int,
  outstanding_total  numeric,
  bad_outstanding    numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  return query
  with ret as (
    -- วันคืนเครื่องล่าสุดต่อสัญญา (Bangkok date)
    select contract_id, max((created_at at time zone 'Asia/Bangkok')::date) as rdate
    from public.device_returns
    group by contract_id
  ),
  logs as (
    -- เงินที่จ่ายจริงทุกรายการตั้งแต่ 1 มิ.ย. 2026 (ก่อนหน้านั้นไม่มีผลต่อ v_min_date ของ get_npl_history = 24 มิ.ย.)
    select contract_id, installment_id, (created_at at time zone 'Asia/Bangkok')::date as ld, amount
    from public.payment_log
    where action = 'pay' and created_at >= timestamptz '2026-06-01'
  ),
  fut as (
    -- log วันอนาคต (เทียบวันนี้จริง ไม่ใช่ p_date) = placeholder ตารางงวดของสัญญาที่ปิดไปแล้วก่อน import
    select distinct contract_id from logs where ld > v_today
  ),
  la_inst as (
    -- เงินที่จ่ายให้แต่ละงวด "หลัง p_date" (ต้องหักคืนตอนคำนวณยอดคงเหลือย้อนหลัง)
    select installment_id, sum(amount) as amt
    from logs
    where ld > p_date and ld <= v_today
    group by installment_id
  ),
  la_con as (
    -- สัญญาที่มีเงินเข้าหลัง p_date (ใช้เดาว่าสัญญา closed ที่ไม่มี settled_at ยังเปิดอยู่ ณ p_date หรือไม่)
    select distinct contract_id
    from logs
    where ld > p_date and ld <= v_today
  ),
  open_at as (
    -- สัญญาที่ "เปิดอยู่" ณ p_date
    select c.id, c.status, c.pending_documents
    from public.contracts c
    left join ret r on r.contract_id = c.id
    left join la_con lc on lc.contract_id = c.id
    where c.transaction_date <= p_date and (
      c.status = 'active'
      or (c.status in ('returned', 'returned_closed') and r.rdate > p_date)
      or (c.status = 'closed' and c.settled_at is not null and (c.settled_at at time zone 'Asia/Bangkok')::date > p_date)
      or (c.status = 'closed' and c.settled_at is null and lc.contract_id is not null and c.id not in (select contract_id from fut))
    )
  ),
  inst as (
    -- งวดที่ยังค้าง ณ p_date; ยอดคงเหลือ = amount − (paid_amount − เงินที่จ่ายหลัง p_date)
    select o.id, i.due_date,
      greatest(i.amount - greatest(coalesce(i.paid_amount, 0) - coalesce(li.amt, 0), 0), 0) as rem
    from open_at o
    join public.installments i on i.contract_id = o.id
    left join la_inst li on li.installment_id = i.id
    where i.paid_at is null or (i.paid_at at time zone 'Asia/Bangkok')::date > p_date
  ),
  per as (
    select o.id, o.status, o.pending_documents,
      min(x.due_date) as oldest_due,
      coalesce(sum(x.rem), 0) as out_total
    from open_at o
    left join inst x on x.id = o.id
    group by o.id, o.status, o.pending_documents
  ),
  f as (
    select per.*,
      case when per.pending_documents or per.oldest_due is null then 0
           else greatest(0, p_date - per.oldest_due)
      end as dl
    from per
  )
  select
    p_date,
    count(*)::int,
    count(*) filter (where dl >= 60)::int,
    round(coalesce(sum(out_total), 0))::numeric,
    round(coalesce(sum(out_total) filter (where dl >= 60), 0))::numeric
  from f;
end;
$$;

revoke all on function public.npl_as_of(date) from public, anon, authenticated;
grant execute on function public.npl_as_of(date) to service_role;

comment on function public.npl_as_of(date) is
  '(0159) คำนวณหนี้เสีย (days_late>=60, สัญญาเปิดอยู่) ณ วันใดก็ได้ จากข้อมูลปัจจุบัน — สูตรเดียวกับ kpiBadDebt60/buildBucketKpi (src/lib/monthlyReport.ts) ณ p_date=วันนี้; หักเงินที่จ่ายหลัง p_date คืนเพื่อจำลองยอดคงเหลือย้อนหลัง; "วันนี้" อ้างอิง Asia/Bangkok เสมอ; service_role เท่านั้น (engine ภายใน — authenticated เรียกผ่าน get_npl_history/record_npl_snapshot)';


-- ============================================================================
-- SECTION 3: record_npl_snapshot(p_date, p_source) — upsert 1 วันเข้า npl_daily_snapshot
-- ============================================================================

create or replace function public.record_npl_snapshot(
  p_date   date,
  p_source text default 'daily'
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row record;
begin
  if p_source not in ('backfill', 'daily') then
    raise exception 'source ไม่ถูกต้อง (ต้องเป็น backfill หรือ daily): %', p_source;
  end if;

  select * into v_row from public.npl_as_of(p_date);

  insert into public.npl_daily_snapshot (
    snapshot_date, active_count, bad_count, outstanding_total, bad_outstanding, source, computed_at
  ) values (
    p_date, v_row.active_count, v_row.bad_count, v_row.outstanding_total, v_row.bad_outstanding, p_source, now()
  )
  on conflict (snapshot_date) do update set
    active_count      = excluded.active_count,
    bad_count         = excluded.bad_count,
    outstanding_total = excluded.outstanding_total,
    bad_outstanding   = excluded.bad_outstanding,
    source            = excluded.source,
    computed_at       = excluded.computed_at;
end;
$$;

revoke all on function public.record_npl_snapshot(date, text) from public, anon, authenticated;
grant execute on function public.record_npl_snapshot(date, text) to service_role;

comment on function public.record_npl_snapshot(date, text) is
  '(0159) upsert 1 แถวของ npl_daily_snapshot ด้วยผลจาก npl_as_of(p_date) — p_source ต้องเป็น backfill|daily เท่านั้น; service_role เท่านั้น (เรียกจาก cron รายคืน + ครีมรัน backfill มือครั้งเดียวตอน apply migration นี้)';


-- ============================================================================
-- SECTION 4: get_npl_history(p_from, p_to) — authenticated (admin/executive) อ่านช่วงวันที่
-- ตรงกับ route gate ของ /monthly-report (App.tsx: (isAdmin || isExecutive)) — ไม่รวม staff/freelancer
-- ============================================================================

create or replace function public.get_npl_history(
  p_from date,
  p_to   date
)
returns table (
  snapshot_date      date,
  active_count       int,
  bad_count          int,
  outstanding_total  numeric,
  bad_outstanding    numeric,
  source             text
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  -- 2026-06-24 ไม่ใช่ 06-16: ก่อนหน้านี้ device_returns มี 66 แถวคีย์ย้อนหลังพร้อมกัน (21/23 มิ.ย. —
  -- created_at=วันคีย์ ไม่ใช่วันคืนจริง) ทำให้ตัวเลข 16–23 มิ.ย. พองเกินจริง (ดู comment หัวไฟล์)
  v_min_date constant date := '2026-06-24';
  v_from date;
  v_to   date;
begin
  -- guard เดียวกับ pattern 0097/0108 — ไม่ใช่ admin/executive → คืน 0 rows (ไม่ raise exception)
  if not (public.is_admin() or public.is_executive()) then
    return;
  end if;

  v_from := greatest(coalesce(p_from, v_min_date), v_min_date);
  v_to   := least(coalesce(p_to, v_today), v_today);

  if v_from > v_to then
    return;
  end if;

  return query
  -- s.snapshot_date < v_today (ติ๊กรีวิว): กันวันนี้ซ้ำ 2 แถวถ้ามีใครบันทึกแถวของวันนี้ลงตารางไปแล้วโดยไม่ตั้งใจ
  -- (เช่น รัน record_npl_snapshot มือผิดวัน) — แถวสดของวันนี้ต่อท้ายด้านล่างเป็นแหล่งเดียวเสมอ
  select s.snapshot_date, s.active_count, s.bad_count, s.outstanding_total, s.bad_outstanding, s.source
  from public.npl_daily_snapshot s
  where s.snapshot_date between v_from and v_to
    and s.snapshot_date < v_today
  order by s.snapshot_date;

  -- ถ้าช่วงที่ขอครอบวันนี้ ต่อท้าย 1 แถวสด (ยังไม่ถูก cron เก็บ เพราะ cron รันตอน 00:15 ของคืนถัดไป)
  if v_to = v_today then
    return query
    select a.as_of_date, a.active_count, a.bad_count, a.outstanding_total, a.bad_outstanding, 'live'::text
    from public.npl_as_of(v_today) a;
  end if;
end;
$$;

revoke all on function public.get_npl_history(date, date) from public, anon, authenticated;
grant execute on function public.get_npl_history(date, date) to authenticated, service_role;

comment on function public.get_npl_history(date, date) is
  '(0159) คืนประวัติหนี้เสียรายวัน [p_from, p_to] (clamp p_from>=2026-06-24 (v_min_date — เลื่อนจาก 06-16 เดิม เพราะ device_returns คีย์ย้อนหลัง 21/23 มิ.ย. ทำตัวเลขพอง, ดู comment หัวไฟล์), p_to<=วันนี้ Asia/Bangkok; p_from>p_to → 0 rows) จาก npl_daily_snapshot + ต่อท้าย 1 แถวสด source=''live'' จาก npl_as_of(วันนี้) ถ้า p_to=วันนี้; guard is_admin() or is_executive() (ตรง route gate /monthly-report ใน App.tsx) — role อื่น 0 rows';


-- ============================================================================
-- SECTION 5: pg_cron — เก็บ snapshot ของ "เมื่อวาน" ทุกคืน 00:15 น. เวลาไทย (= 17:15 UTC)
-- ทำไมเก็บของเมื่อวาน ไม่ใช่วันนี้: ตอน 00:15 น. วันนี้เพิ่งเริ่ม ข้อมูลของ "วันนี้" ยังไม่นิ่ง (get_npl_history
-- คำนวณสดของวันนี้เองผ่าน source='live' อยู่แล้วทุกครั้งที่มีคนเปิดหน้า ไม่ต้องพึ่ง cron)
-- ============================================================================

select cron.unschedule('npl-daily-snapshot')
where exists (select 1 from cron.job where jobname = 'npl-daily-snapshot');

select cron.schedule(
  'npl-daily-snapshot',
  '15 17 * * *',
  $$ select public.record_npl_snapshot(((now() at time zone 'Asia/Bangkok')::date - 1), 'daily'); $$
);


-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) ตาราง + สิทธิ์ service_role ครบ (Edge/cron จะพังถ้าไม่ผ่าน):
-- select has_table_privilege('service_role', 'public.npl_daily_snapshot', 'SELECT'); -- true
-- select has_table_privilege('service_role', 'public.npl_daily_snapshot', 'INSERT'); -- true

-- b) authenticated/anon ต้องอ่านตารางตรงไม่ได้ (อ่านผ่าน RPC เท่านั้น):
-- select has_table_privilege('authenticated', 'public.npl_daily_snapshot', 'SELECT'); -- false
-- select has_table_privilege('anon', 'public.npl_daily_snapshot', 'SELECT');          -- false

-- c) npl_as_of/record_npl_snapshot: service_role เรียกได้ authenticated/anon เรียกไม่ได้:
-- select has_function_privilege('service_role', 'public.npl_as_of(date)', 'EXECUTE');               -- true
-- select has_function_privilege('authenticated', 'public.npl_as_of(date)', 'EXECUTE');               -- false
-- select has_function_privilege('service_role', 'public.record_npl_snapshot(date,text)', 'EXECUTE'); -- true
-- select has_function_privilege('authenticated', 'public.record_npl_snapshot(date,text)', 'EXECUTE');-- false

-- d) get_npl_history: authenticated เรียกได้ (guard เช็คข้างในเอง), anon เรียกไม่ได้:
-- select has_function_privilege('authenticated', 'public.get_npl_history(date,date)', 'EXECUTE'); -- true
-- select has_function_privilege('anon', 'public.get_npl_history(date,date)', 'EXECUTE');           -- false

-- e) npl_as_of ตรงกับการ์ดจริง (ค่าคาดหวัง ณ 2026-09-16 — อาจขยับนิดหน่อยถ้าข้อมูลถูกแก้ทีหลัง):
-- select * from public.npl_as_of('2026-08-31'::date); -- expected: 2259 / 160 / ~3,747,221 / ~64,163,098
-- select * from public.npl_as_of('2026-07-31'::date); -- expected: 2085 / 128 / ~2,943,058 / ~52,565,347
-- select * from public.npl_as_of('2026-06-30'::date); -- expected: 1965 /  98 / ~2,133,806 / ~48,494,337
-- select * from public.npl_as_of((now() at time zone 'Asia/Bangkok')::date); -- expected: ตรงการ์ด kpiBadDebt60 สดของวันนี้

-- f) cron ตั้งสำเร็จ:
-- select jobid, jobname, schedule, active from cron.job where jobname = 'npl-daily-snapshot'; -- 1 แถว, active=true

-- g) หลัง backfill (ดูคำสั่งด้านล่าง) เช็คจำนวนวัน + ไม่มีวันตกหล่นในช่วง [2026-06-24, เมื่อวาน]:
-- select count(*), min(snapshot_date), max(snapshot_date) from public.npl_daily_snapshot;
-- select gs::date as missing_date
--   from generate_series('2026-06-24'::date, ((now() at time zone 'Asia/Bangkok')::date - 1), interval '1 day') gs
--  where gs::date not in (select snapshot_date from public.npl_daily_snapshot);
-- expected: 0 rows
-- (ถ้ามีแถว 2026-06-16..2026-06-23 ค้างจากรอบทดสอบก่อนหน้า — ครีมลบเองแยกนอกไฟล์นี้ ไม่ใช่ backfill ใหม่)


-- ============================================================================
-- คำสั่ง Backfill (ครีมรันเองหลัง apply migration นี้สำเร็จ — ไม่ใส่ loop ในไฟล์ migration เพราะเสี่ยง
-- statement timeout ถ้ารันทีเดียวหลายสิบวันรวด — แบ่งรันเป็น chunk ทีละ ~15-20 วันผ่าน MCP execute_sql)
-- ============================================================================

-- chunk แนะนำ (ปรับช่วงได้ตามจริง — 2026-06-24 ถึงเมื่อวาน ณ วันที่รัน — เริ่ม 06-24 ไม่ใช่ 06-16 เพราะ
-- device_returns คีย์ย้อนหลัง 21/23 มิ.ย. ทำตัวเลขพอง, ดู comment หัวไฟล์):
-- do $$
-- declare v_d date;
-- begin
--   for v_d in select generate_series('2026-06-24'::date, '2026-07-05'::date, interval '1 day')::date
--   loop
--     perform public.record_npl_snapshot(v_d, 'backfill');
--   end loop;
-- end $$;
--
-- -- ต่อด้วยรอบถัดๆ ไป (ตัวอย่างแบ่ง 3-4 รอบ):
-- --   2026-07-06 .. 2026-07-25
-- --   2026-07-26 .. 2026-08-14
-- --   2026-08-15 .. 2026-09-03
-- --   2026-09-04 .. เมื่อวาน (ณ วันที่ครีมรันจริง)
