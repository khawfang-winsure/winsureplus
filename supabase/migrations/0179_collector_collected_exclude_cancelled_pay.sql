-- 0179: ยอดเก็บต่อพนักงานไม่นับเงินที่ถูกยกเลิก (4 ฟังก์ชัน scorecard) — ต่อจาก 0178
-- กติกาเดียวกับ 0178: ตัดแถว payment_log action='pay' ที่ installment_id ไม่ null และมี action='cancel' ของงวดเดียวกัน
--   ที่ created_at > แถว pay (ใช้ > เท่านั้น); ไม่ลบ/แก้ข้อมูลใด ๆ
-- เปลี่ยนเฉพาะเงื่อนไขนี้ — signature / return type / security definer / stable / search_path / guard สิทธิ์ คงเดิมทุกตัว
-- ต้นทางเนื้อฟังก์ชัน: get_collector_scorecard = 0119 (สดสุด; เดิม 0046/0098) ·
--   get_my_collector_scorecard = 0048 · get_collector_collection_by_bucket = 0118 · get_uncredited_collected = 0098
-- CREATE OR REPLACE คง grant เดิม; ไม่เพิ่มสิทธิ์; ไม่เพิ่ม at time zone ใหม่

create or replace function public.get_collector_scorecard(
  p_start date,
  p_end   date
)
returns table (
  author_id           uuid,
  current_grade       text,      -- ครีม: per-grade drill-down (null = สัญญาไม่มีเกรด — คงไว้ กัน total เพี้ยน)
  calls               int,       -- (b) จำนวนสายโทร contact_method='phone' ในช่วง
  unique_contracts    int,       -- (c) distinct CONTRACT (ทุก contact_method) — label UI "สัญญาที่ดูแล"
  total_attempts      int,       -- ทุก follow_up ในช่วง (denominator contact-rate)
  successful_attempts int,       -- (0119) result ∈ (contacted,promised,paid,refused,returned) — เดิม (...,returned,other)
  collected_baht      numeric,   -- (a) last-touch attribution — SUM(amount) ก้อนที่ชนะ
  last_activity_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- (a) ยอดเก็บ last-touch: แต่ละ payment_log 'pay' ในช่วง → หาสาย freelancer ที่นำก่อน 1 สาย
  paid_events as (
    select
      pl.id          as payment_id,
      pl.contract_id,
      pl.amount,
      pl.created_at  as paid_ts
    from public.payment_log pl
    where pl.action = 'pay'
      and not (
        pl.installment_id is not null
        and exists (
          select 1 from public.payment_log c
          where c.action = 'cancel'
            and c.installment_id = pl.installment_id
            and c.created_at > pl.created_at
        )
      )   -- (0179) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
      and (pl.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  last_touch as (
    -- DISTINCT ON (payment_id): ผู้ชนะคือสายที่ created_at มากสุด (ใกล้ paid_ts สุด)
    -- tie-break เวลาเป๊ะกัน → f.id desc → deterministic
    select distinct on (pe.payment_id)
      pe.payment_id,
      pe.amount,
      pe.contract_id,
      f.author_id    as winner_author_id
    from paid_events pe
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.contact_method = 'phone'
      and f.created_at < pe.paid_ts                              -- strictly before
      and f.created_at >= pe.paid_ts - interval '7 days'         -- ภายใน 7 วัน (ระดับ timestamp)
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    order by pe.payment_id, f.created_at desc, f.id desc
  ),
  collected as (
    -- group ยอดที่ชนะตาม (winner, current_grade ของสัญญานั้น) — mirror per-grade ของ fu_metrics
    select
      lt.winner_author_id as author_id,
      c.current_grade,
      sum(lt.amount)      as collected_baht
    from last_touch lt
    join public.contracts c on c.id = lt.contract_id
    group by lt.winner_author_id, c.current_grade
  ),
  -- (b)(c) + attempts: 1 scan ของ follow_ups ในช่วง ของ freelancer active, group by author + grade
  fu_metrics as (
    select
      f.author_id,
      c.current_grade,
      count(*) filter (where f.contact_method = 'phone')::int                          as calls,
      count(distinct f.contract_id)::int                                               as unique_contracts,
      count(*)::int                                                                    as total_attempts,
      -- (0119) รวมนิยาม "โทรติด" กับ get_collector_call_outcomes: ตัด 'other' ออก เพิ่ม 'refused' เข้า
      count(*) filter (
        where f.follow_up_result in ('contacted','promised','paid','refused','returned')
      )::int                                                                           as successful_attempts,
      max(f.created_at)                                                                as last_activity_at
    from public.follow_ups f
    join public.contracts c on c.id = f.contract_id
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
    group by f.author_id, c.current_grade
  )
  select
    coalesce(m.author_id, col.author_id)        as author_id,
    coalesce(m.current_grade, col.current_grade) as current_grade,
    coalesce(m.calls, 0)                         as calls,
    coalesce(m.unique_contracts, 0)              as unique_contracts,
    coalesce(m.total_attempts, 0)                as total_attempts,
    coalesce(m.successful_attempts, 0)           as successful_attempts,
    coalesce(col.collected_baht, 0)::numeric     as collected_baht,
    m.last_activity_at                           as last_activity_at
  from fu_metrics m
  full outer join collected col
    on col.author_id = m.author_id
    and col.current_grade is not distinct from m.current_grade   -- null-safe join (สัญญาไม่มีเกรด)
  where public.is_admin() or public.is_staff() or public.is_executive();  -- guard: freelancer/anon → 0 rows; exec เห็นได้ (no PII)
$$;

create or replace function public.get_my_collector_scorecard(
  p_start date,
  p_end   date
)
returns table (
  author_id           uuid,
  current_grade       text,
  calls               int,
  unique_contracts    int,
  total_attempts      int,
  successful_attempts int,
  collected_baht      numeric,
  last_activity_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- (a) last-touch GLOBAL — ไม่ใส่ auth.uid() ที่นี่ (winner ต้องแข่งกับทุกคน)
  paid_events as (
    select
      pl.id          as payment_id,
      pl.contract_id,
      pl.amount,
      pl.created_at  as paid_ts
    from public.payment_log pl
    where pl.action = 'pay'
      and not (
        pl.installment_id is not null
        and exists (
          select 1 from public.payment_log c
          where c.action = 'cancel'
            and c.installment_id = pl.installment_id
            and c.created_at > pl.created_at
        )
      )   -- (0179) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
      and (pl.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  last_touch as (
    select distinct on (pe.payment_id)
      pe.payment_id,
      pe.amount,
      pe.contract_id,
      f.author_id    as winner_author_id
    from paid_events pe
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.contact_method = 'phone'
      and f.created_at < pe.paid_ts
      and f.created_at >= pe.paid_ts - interval '7 days'
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    order by pe.payment_id, f.created_at desc, f.id desc
  ),
  -- collected: กรองเฉพาะก้อนที่ caller เป็น winner
  collected as (
    select
      lt.winner_author_id as author_id,
      c.current_grade,
      sum(lt.amount)      as collected_baht
    from last_touch lt
    join public.contracts c on c.id = lt.contract_id
    where lt.winner_author_id = auth.uid()              -- self-filter: เฉพาะก้อนที่ฉันชนะ
    group by lt.winner_author_id, c.current_grade
  ),
  -- fu_metrics: เฉพาะ follow_ups ของ caller
  fu_metrics as (
    select
      f.author_id,
      c.current_grade,
      count(*) filter (where f.contact_method = 'phone')::int                          as calls,
      count(distinct f.contract_id)::int                                               as unique_contracts,
      count(*)::int                                                                    as total_attempts,
      count(*) filter (
        where f.follow_up_result in ('contacted','promised','paid','returned','other')
      )::int                                                                           as successful_attempts,
      max(f.created_at)                                                                as last_activity_at
    from public.follow_ups f
    join public.contracts c on c.id = f.contract_id
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
      and f.author_id = auth.uid()                      -- self-filter: เฉพาะสายของฉัน
    group by f.author_id, c.current_grade
  )
  select
    coalesce(m.author_id, col.author_id)        as author_id,
    coalesce(m.current_grade, col.current_grade) as current_grade,
    coalesce(m.calls, 0)                         as calls,
    coalesce(m.unique_contracts, 0)              as unique_contracts,
    coalesce(m.total_attempts, 0)                as total_attempts,
    coalesce(m.successful_attempts, 0)           as successful_attempts,
    coalesce(col.collected_baht, 0)::numeric     as collected_baht,
    m.last_activity_at                           as last_activity_at
  from fu_metrics m
  full outer join collected col
    on col.author_id = m.author_id
    and col.current_grade is not distinct from m.current_grade
  -- ไม่มี WHERE guard — self-scope มาจาก auth.uid() filter ในแต่ละ CTE แล้ว
$$;

create or replace function public.get_collector_collection_by_bucket(
  p_start date,
  p_end   date
)
returns table (
  author_id       uuid,
  author_name     text,
  bucket          text,
  payments        int,
  collected_baht  numeric
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- ยอดจ่ายจริงในช่วง (action='pay' เท่านั้น) — เหมือน 0098 paid_events เป๊ะ
  paid_events as (
    select
      pl.id             as payment_id,
      pl.contract_id,
      pl.installment_id,
      pl.amount,
      pl.created_at     as paid_ts
    from public.payment_log pl
    where pl.action = 'pay'
      and not (
        pl.installment_id is not null
        and exists (
          select 1 from public.payment_log c
          where c.action = 'cancel'
            and c.installment_id = pl.installment_id
            and c.created_at > pl.created_at
        )
      )   -- (0179) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
      and (pl.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  -- last-touch attribution — copy เป๊ะจาก 0098 get_collector_scorecard (ห้ามเบี่ยงเบน ไม่งั้น cross-check ไม่ตรง)
  -- ดึง author_name จาก follow_ups.author_name (snapshot ตอน insert, not null เสมอ — 0018) ของสายที่ชนะ
  -- แทนที่จะใช้ profiles.full_name (nullable และอาจเปลี่ยนภายหลัง ไม่ตรงกับ "ใครโทรตอนนั้น")
  last_touch as (
    select distinct on (pe.payment_id)
      pe.payment_id,
      pe.amount,
      pe.contract_id,
      pe.installment_id,
      pe.paid_ts,
      f.author_id       as winner_author_id,
      f.author_name     as winner_author_name
    from paid_events pe
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.contact_method = 'phone'
      and f.created_at < pe.paid_ts                              -- strictly before
      and f.created_at >= pe.paid_ts - interval '7 days'         -- ภายใน 7 วัน (ระดับ timestamp)
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    order by pe.payment_id, f.created_at desc, f.id desc
  ),
  -- bucket ตาม "วันจ่ายจริง (เวลาไทย) − installments.due_date" — left join กัน link ขาดทิ้งแถวเงียบ
  bucketed as (
    select
      lt.winner_author_id   as author_id,
      lt.winner_author_name as author_name,
      lt.amount,
      case
        when i.due_date is null then 'ไม่ทราบช่วง'
        else (
          case
            when (lt.paid_ts at time zone 'Asia/Bangkok')::date - i.due_date <= 0   then 'ตรงเวลา'
            when (lt.paid_ts at time zone 'Asia/Bangkok')::date - i.due_date <= 10  then '1-10'
            when (lt.paid_ts at time zone 'Asia/Bangkok')::date - i.due_date <= 30  then '11-30'
            when (lt.paid_ts at time zone 'Asia/Bangkok')::date - i.due_date <= 60  then '31-60'
            when (lt.paid_ts at time zone 'Asia/Bangkok')::date - i.due_date <= 90  then '61-90'
            when (lt.paid_ts at time zone 'Asia/Bangkok')::date - i.due_date <= 120 then '91-120'
            else '120+'
          end
        )
      end as bucket
    from last_touch lt
    left join public.installments i on i.id = lt.installment_id
  )
  select
    b.author_id,
    b.author_name,
    b.bucket,
    count(*)::int          as payments,
    sum(b.amount)::numeric as collected_baht
  from bucketed b
  where public.is_admin() or public.is_staff() or public.is_executive()   -- guard: freelancer/anon → 0 rows
  group by b.author_id, b.author_name, b.bucket;
$$;

create or replace function public.get_uncredited_collected(
  p_start date,
  p_end   date
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case when (public.is_admin() or public.is_staff() or public.is_executive()) then
    coalesce((
      select sum(pl.amount)
      from public.payment_log pl
      where pl.action = 'pay'
        and not (
          pl.installment_id is not null
          and exists (
            select 1 from public.payment_log c
            where c.action = 'cancel'
              and c.installment_id = pl.installment_id
              and c.created_at > pl.created_at
          )
        )   -- (0179) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
        and (pl.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
        and not exists (
          select 1
          from public.follow_ups f
          join public.profiles pr
            on pr.id = f.author_id
            and pr.role = 'freelancer'
            and pr.active = true
          where f.contract_id = pl.contract_id
            and f.contact_method = 'phone'
            and f.created_at < pl.created_at                       -- strictly before
            and f.created_at >= pl.created_at - interval '7 days'  -- ภายใน 7 วัน
        )
    ), 0)
  else 0::numeric end;
$$;

-- ============================================================================
-- Verify (ครีมรันหลัง apply) — ไม่ต้องล็อกอิน: ฟังก์ชันเช็ค is_admin()/auth.uid() ผ่าน MCP จะได้ว่าง
-- จึงเทียบด้วย SQL ตรงบน payment_log แทน
-- ============================================================================
-- 1) ยอดที่ควรถูกตัดออกจากยอดเก็บรวมช่วง (ใช้เทียบก่อน/หลัง; เปลี่ยนช่วงวันได้):
-- SELECT count(*) rows_cut, coalesce(sum(p.amount),0) baht_cut
--   FROM public.payment_log p
--  WHERE p.action='pay' AND p.installment_id IS NOT NULL
--    AND (p.created_at at time zone 'Asia/Bangkok')::date BETWEEN '2026-07-01' AND '2026-11-30'
--    AND EXISTS (SELECT 1 FROM public.payment_log c WHERE c.action='cancel'
--                AND c.installment_id=p.installment_id AND c.created_at>p.created_at);
-- 2) ยอด pay ที่ "นับ" ต่อเดือน (ควรเท่ากับ v_cashflow_daily รายเดือน = ยอดรวมที่ฟังก์ชันทั้งหมดต้องรวมกันได้ collected+uncredited):
-- SELECT to_char(pay_date,'YYYY-MM') m, sum(income) FROM public.v_cashflow_daily GROUP BY 1 ORDER BY 1;
-- 3) ยืนยันว่าฟังก์ชันถูกแทนที่แล้วและมีข้อความตัด cancel (security definer, stable คงเดิม):
-- SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig,
--        position('c.action = ''cancel''' in pg_get_functiondef(p.oid)) > 0 AS has_cancel_filter
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public' AND p.proname IN
--   ('get_collector_scorecard','get_my_collector_scorecard','get_collector_collection_by_bucket','get_uncredited_collected');
--   -- คาด: prosecdef=true, provolatile='s', proconfig มี search_path, has_cancel_filter=true ทั้ง 4 แถว
-- 4) successful_attempts list ยังต่างกันตามเดิม (ห้ามทำให้เหมือน):
-- SELECT p.proname, pg_get_functiondef(p.oid) ~ 'refused' AS has_refused
--   FROM pg_proc p WHERE p.proname IN ('get_collector_scorecard','get_my_collector_scorecard');
--   -- คาด: get_collector_scorecard = true, get_my_collector_scorecard = false
-- 5) grants คงเดิม:
-- SELECT has_function_privilege('authenticated','public.get_collector_scorecard(date,date)','EXECUTE'),
--        has_function_privilege('authenticated','public.get_my_collector_scorecard(date,date)','EXECUTE'),
--        has_function_privilege('authenticated','public.get_collector_collection_by_bucket(date,date)','EXECUTE'),
--        has_function_privilege('authenticated','public.get_uncredited_collected(date,date)','EXECUTE');
-- 6) invariant (ตรวจในแอปที่ล็อกอิน admin ภายหลัง): collected(scorecard รวมทุกเกรด) + get_uncredited_collected = sum(income) ของ v_cashflow_daily ช่วงเดียวกัน
--    และ sum(collected_baht) ของ get_collector_collection_by_bucket ต่อคน = ของ get_collector_scorecard ต่อคน
