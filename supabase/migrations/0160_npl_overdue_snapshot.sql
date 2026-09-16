-- 0160: เพิ่มเส้น "ค้างทั้งหมด" (days_late >= 1) คู่กับเส้นหนี้เสีย (>=60) ในกราฟ /exec — ใช้ snapshot เดิมของ 0159
-- ────────────────────────────────────────────────────────────────────────────
-- บริบท: 0159 เก็บ npl_daily_snapshot ไว้แค่ตัวเลข "หนี้เสีย" (days_late>=60) สำหรับการ์ด /monthly-report
-- คุณเตยอยากเห็นอีกเส้นบนกราฟ /exec = "สัญญาค้างทั้งหมด" (days_late>=1 ขึ้นไป — รวม 60+ อยู่ในนี้ด้วย)
-- เทียบคู่กัน วันต่อวัน สูตร/ขอบเขตสัญญาต้องเหมือน npl_as_of เป๊ะ ต่างแค่ threshold (>=1 แทน >=60)
--
-- ทำไมไม่แก้ npl_as_of ตรงๆ: คงไว้ตามเดิมทุกตัวอักษร (คนอื่นอาจเรียกอยู่แล้ว + เอกสาร 0159 อ้างอิงผลลัพธ์คงที่)
-- เพิ่มฟังก์ชันใหม่ npl_as_of_v2 ที่ "คำนวณรอบเดียว" จาก CTE ชุดเดิม (copy จาก 0159 ทั้งหมด ไม่ตัดทอน กันพลาด
-- ผลต่างจาก v1) แล้วเพิ่ม aggregate อีก 2 ตัว (dl>=1) ในขั้น select สุดท้าย — ห้ามรัน query หนักซ้ำสองรอบ
-- (memory 0159: correlated subquery ต่อแถวจากสัญญา 2,300+ แถว = statement timeout)
--
-- คอลัมน์ใหม่ overdue_count/overdue_outstanding เป็น NULLABLE โดยตั้งใจ — แถวเก่าก่อน backfill (ดูไฟล์
-- npl0160_backfill.sql แยกนอก migration) ยังไม่มีค่า จน backfill เสร็จ ไม่ error ฝั่ง frontend เพราะ types.ts
-- ประกาศเป็น `overdueCount?: number | null` — การ์ด/กราฟที่ยังไม่มีข้อมูลแสดงเป็นช่องว่าง ไม่ใช่ 0 ปลอม
--
-- get_npl_history เปลี่ยน return type (เพิ่ม 2 คอลัมน์) → ต้อง drop signature เดิมก่อนสร้างใหม่ (Postgres
-- ไม่ยอม create or replace ถ้า return columns ไม่ตรงเป๊ะ) คงทุกอย่างจาก 0159 ไว้ (guard is_admin/is_executive,
-- clamp p_from>=2026-06-24, แถวสดกันซ้ำวันนี้ ฯลฯ) เพิ่มพารามิเตอร์ตัวที่ 3 p_month_end_only (default false)
-- ไว้ท้ายสุด เพื่อไม่กระทบ caller 2-arg เดิม (MonthlyReport.tsx ยังเรียก getNplHistory(from, to) 2 ตัวได้ปกติ —
-- ฝั่ง DB ใช้ default เอง) — ใช้ตอนกราฟ /exec อยากได้แค่จุดสิ้นเดือน (เบาลง ไม่ต้อง plot ทุกวัน) แต่ยังมีจุด
-- ล่าสุด <= p_to (เดือนปัจจุบัน/บางส่วน) ให้เห็นเทรนด์ต่อเนื่อง
--
-- Additive/idempotent — add column if not exists, create or replace, drop function if exists ก่อนสร้างใหม่
-- (เฉพาะตัวที่ return type เปลี่ยน) — ไม่ backfill loop ในไฟล์นี้ (แยกเป็น npl0160_backfill.sql รันเป็น chunk)

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์ overdue_count/overdue_outstanding บน npl_daily_snapshot (nullable — ยังไม่ backfill)
-- ============================================================================

alter table public.npl_daily_snapshot
  add column if not exists overdue_count int,
  add column if not exists overdue_outstanding numeric;

comment on column public.npl_daily_snapshot.overdue_count is
  '(0160) จำนวนสัญญาค้าง days_late>=1 ณ วันนั้น (รวมกลุ่ม bad_count/60+ อยู่ในนี้ด้วยเสมอ overdue_count>=bad_count) — null = แถวเก่ายังไม่ backfill';
comment on column public.npl_daily_snapshot.overdue_outstanding is
  '(0160) ยอดคงเหลือทั้งสัญญาของกลุ่ม days_late>=1 (overdue_outstanding>=bad_outstanding เสมอ) — null = แถวเก่ายังไม่ backfill';


-- ============================================================================
-- SECTION 2: npl_as_of_v2(p_date) — เหมือน npl_as_of ทุกจุด (CTE ชุดเดิมจาก 0159 ไม่ตัดทอน) +
-- คำนวณ overdue_count/overdue_outstanding (dl>=1) เพิ่มในขั้น aggregate สุดท้าย รอบเดียวจบ ไม่รันซ้ำ
-- ============================================================================

create or replace function public.npl_as_of_v2(p_date date)
returns table (
  as_of_date          date,
  active_count        int,
  bad_count           int,
  outstanding_total   numeric,
  bad_outstanding     numeric,
  overdue_count       int,
  overdue_outstanding numeric
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
    round(coalesce(sum(out_total) filter (where dl >= 60), 0))::numeric,
    count(*) filter (where dl >= 1)::int,
    round(coalesce(sum(out_total) filter (where dl >= 1), 0))::numeric
  from f;
end;
$$;

revoke all on function public.npl_as_of_v2(date) from public, anon, authenticated;
grant execute on function public.npl_as_of_v2(date) to service_role;

comment on function public.npl_as_of_v2(date) is
  '(0160) เหมือน npl_as_of(date) ทุกจุด (สูตร/ขอบเขตสัญญาเดียวกัน) + คำนวณ overdue_count/overdue_outstanding (days_late>=1) เพิ่มในรอบเดียวกัน ไม่รัน query หนักซ้ำ — npl_as_of เดิมคงไว้ไม่แตะ (คนอื่นอาจเรียกอยู่); service_role เท่านั้น (engine ภายใน — authenticated เรียกผ่าน get_npl_history/record_npl_snapshot)';


-- ============================================================================
-- SECTION 3: record_npl_snapshot(p_date, p_source) — เปลี่ยนมาใช้ npl_as_of_v2 เขียนครบทุกคอลัมน์ (signature เดิม)
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

  select * into v_row from public.npl_as_of_v2(p_date);

  insert into public.npl_daily_snapshot (
    snapshot_date, active_count, bad_count, outstanding_total, bad_outstanding,
    overdue_count, overdue_outstanding, source, computed_at
  ) values (
    p_date, v_row.active_count, v_row.bad_count, v_row.outstanding_total, v_row.bad_outstanding,
    v_row.overdue_count, v_row.overdue_outstanding, p_source, now()
  )
  on conflict (snapshot_date) do update set
    active_count        = excluded.active_count,
    bad_count            = excluded.bad_count,
    outstanding_total    = excluded.outstanding_total,
    bad_outstanding       = excluded.bad_outstanding,
    overdue_count         = excluded.overdue_count,
    overdue_outstanding   = excluded.overdue_outstanding,
    source                = excluded.source,
    computed_at           = excluded.computed_at;
end;
$$;

revoke all on function public.record_npl_snapshot(date, text) from public, anon, authenticated;
grant execute on function public.record_npl_snapshot(date, text) to service_role;

comment on function public.record_npl_snapshot(date, text) is
  '(0160) upsert 1 แถวของ npl_daily_snapshot ด้วยผลจาก npl_as_of_v2(p_date) — เขียนครบทั้งคอลัมน์เดิม (0159) และ overdue_count/overdue_outstanding ใหม่; p_source ต้องเป็น backfill|daily เท่านั้น; service_role เท่านั้น (เรียกจาก cron รายคืน + ครีมรัน backfill มือ)';


-- ============================================================================
-- SECTION 4: get_npl_history(p_from, p_to, p_month_end_only) — return type เปลี่ยน (เพิ่ม 2 คอลัมน์) ต้อง
-- drop signature เดิม (date,date) ก่อน แล้วสร้างใหม่แบบ 3 พารามิเตอร์ (ตัวที่ 3 default false ไม่กระทบ caller เดิม)
-- ตรงกับ route gate ของ /monthly-report และ /exec (App.tsx: isAdmin || isExecutive) — ไม่รวม staff/freelancer
-- ============================================================================

drop function if exists public.get_npl_history(date, date);

create or replace function public.get_npl_history(
  p_from            date,
  p_to              date,
  p_month_end_only  boolean default false
)
returns table (
  snapshot_date        date,
  active_count         int,
  bad_count             int,
  outstanding_total     numeric,
  bad_outstanding       numeric,
  overdue_count         int,
  overdue_outstanding   numeric,
  source                text
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  -- 2026-06-24 ไม่ใช่ 06-16: ก่อนหน้านี้ device_returns มี 66 แถวคีย์ย้อนหลังพร้อมกัน (21/23 มิ.ย. —
  -- created_at=วันคีย์ ไม่ใช่วันคืนจริง) ทำให้ตัวเลข 16–23 มิ.ย. พองเกินจริง (ดู comment หัวไฟล์ 0159)
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
  with base as (
    -- s.snapshot_date < v_today (ติ๊กรีวิว 0159): กันวันนี้ซ้ำ 2 แถวถ้ามีใครบันทึกแถวของวันนี้ลงตารางไปแล้ว
    -- โดยไม่ตั้งใจ (เช่น รัน record_npl_snapshot มือผิดวัน) — แถวสดของวันนี้ต่อท้ายด้านล่างเป็นแหล่งเดียวเสมอ
    select s.snapshot_date, s.active_count, s.bad_count, s.outstanding_total, s.bad_outstanding,
           s.overdue_count, s.overdue_outstanding, s.source
    from public.npl_daily_snapshot s
    where s.snapshot_date between v_from and v_to
      and s.snapshot_date < v_today

    union all

    -- ถ้าช่วงที่ขอครอบวันนี้ ต่อท้าย 1 แถวสด (ยังไม่ถูก cron เก็บ เพราะ cron รันตอน 00:15 ของคืนถัดไป)
    select a.as_of_date, a.active_count, a.bad_count, a.outstanding_total, a.bad_outstanding,
           a.overdue_count, a.overdue_outstanding, 'live'::text
    from public.npl_as_of_v2(v_today) a
    where v_to = v_today
  ),
  maxd as (
    select max(b.snapshot_date) as d from base b
  )
  select b.snapshot_date, b.active_count, b.bad_count, b.outstanding_total, b.bad_outstanding,
         b.overdue_count, b.overdue_outstanding, b.source
  from base b, maxd
  where not p_month_end_only
     or b.source = 'live'
     or b.snapshot_date = maxd.d  -- แถวล่าสุด <= p_to เสมอมีจุดให้เห็น แม้เดือนปัจจุบันยังไม่จบ
     or b.snapshot_date = (date_trunc('month', b.snapshot_date) + interval '1 month - 1 day')::date  -- สิ้นเดือน
  order by b.snapshot_date;
end;
$$;

revoke all on function public.get_npl_history(date, date, boolean) from public, anon, authenticated;
grant execute on function public.get_npl_history(date, date, boolean) to authenticated, service_role;

comment on function public.get_npl_history(date, date, boolean) is
  '(0160) คืนประวัติหนี้เสีย+ค้างทั้งหมดรายวัน [p_from, p_to] (clamp p_from>=2026-06-24, p_to<=วันนี้ Asia/Bangkok) จาก npl_daily_snapshot + ต่อท้ายแถวสด source=''live'' จาก npl_as_of_v2(วันนี้) ถ้า p_to=วันนี้ — เพิ่ม overdue_count/overdue_outstanding (days_late>=1) จาก 0159; p_month_end_only=true กรองเหลือแถวสิ้นเดือน + แถวล่าสุด<=p_to + แถวสด (ใช้กับกราฟ /exec ให้เบาลง); guard is_admin() or is_executive() (route gate /monthly-report, /exec) — role อื่น 0 rows';


-- ============================================================================
-- Verify checklist สั้นๆ (รายละเอียดเต็มอยู่ scratchpad npl0160_verify.sql — ครีมรันแยกหลัง apply)
-- ============================================================================

-- a) คอลัมน์ใหม่มีจริง + nullable:
-- select column_name, is_nullable from information_schema.columns
--  where table_name = 'npl_daily_snapshot' and column_name in ('overdue_count','overdue_outstanding');

-- b) สิทธิ์ npl_as_of_v2/get_npl_history ตรง pattern เดิม (service_role / authenticated ตามลำดับ):
-- select has_function_privilege('service_role', 'public.npl_as_of_v2(date)', 'EXECUTE');                    -- true
-- select has_function_privilege('authenticated', 'public.npl_as_of_v2(date)', 'EXECUTE');                    -- false
-- select has_function_privilege('authenticated', 'public.get_npl_history(date,date,boolean)', 'EXECUTE');    -- true
-- select has_function_privilege('anon', 'public.get_npl_history(date,date,boolean)', 'EXECUTE');             -- false

-- c) 2-arg caller เดิม (MonthlyReport.tsx) ยังเรียกได้ผ่าน default p_month_end_only=false:
-- select * from public.get_npl_history('2026-08-01'::date, '2026-08-31'::date) limit 3;

-- d) backfill (แยกไฟล์ npl0160_backfill.sql) + verify (npl0160_verify.sql) รันหลัง apply migration นี้เท่านั้น
