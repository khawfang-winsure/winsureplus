-- 0180: ไม่นับแถวจ่ายเงินที่ถูกยกเลิก (payment_log action='pay' + มี 'cancel' งวดเดียวกันที่ created_at > pay) ในอีก 4 จุด — ต่อจาก 0178/0179
-- จุดที่แก้ (ต้นทางนิยามล่าสุด): v_letter_outcomes = 0069 · v_promise_attribution_30d = 0024 (security_invoker=on คงไว้) ·
--   get_promise_attribution(int) = 0028 (security invoker คงไว้) · get_collector_call_outcomes(date,date) = 0119 (security definer คงไว้)
-- ไม่ลบ/แก้ข้อมูล; คอลัมน์/signature/สิทธิ์/option คงเดิม (create or replace คง grant เดิม); ไม่เพิ่ม at time zone ใหม่
-- สิ่งที่ไม่แตะ: v_partial_payment_progress, เกณฑ์ promised_amount*0.8 ใน get_collector_call_outcomes

create or replace view public.v_letter_outcomes as
with letters as (
  select
    cl.id          as letter_id,
    cl.contract_id,
    cl.round,
    cl.printed_at,
    cl.episode_key,
    lead(cl.printed_at) over (
      partition by cl.contract_id order by cl.printed_at
    ) as next_letter_at
  from public.collection_letters cl
),
resolved as (
  select
    l.*,
    -- จ่ายครั้งแรกหลังส่งจดหมายฉบับนี้
    (select min(pl.created_at)
       from public.payment_log pl
      where pl.contract_id = l.contract_id
        and pl.action = 'pay'
        and not (
          pl.installment_id is not null
          and exists (
            select 1 from public.payment_log cp
            where cp.action = 'cancel'
              and cp.installment_id = pl.installment_id
              and cp.created_at > pl.created_at
          )
        ) -- (0180) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
        and pl.created_at > l.printed_at) as first_pay_at,
    -- คืนเครื่องครั้งแรกหลังส่งจดหมายฉบับนี้
    (select min(dr.created_at)
       from public.device_returns dr
      where dr.contract_id = l.contract_id
        and dr.created_at > l.printed_at) as first_return_at
  from letters l
),
candidates as (
  select
    r.*,
    case when r.first_pay_at is not null
          and (r.next_letter_at is null or r.first_pay_at < r.next_letter_at)
         then r.first_pay_at end as cand_pay,
    case when r.first_return_at is not null
          and (r.next_letter_at is null or r.first_return_at < r.next_letter_at)
         then r.first_return_at end as cand_return
  from resolved r
),
outcomes as (
  select
    c.*,
    -- เวลาตอบสนอง = ตัวที่เร็วกว่า (null-safe: least() ข้าม null ให้อยู่แล้ว)
    least(c.cand_pay, c.cand_return) as responded_at,
    case
      when c.cand_pay is null and c.cand_return is null then 'no_response'
      when c.cand_return is null then 'paid'
      when c.cand_pay is null then 'returned'
      when c.cand_pay <= c.cand_return then 'paid'
      else 'returned'
    end as outcome
  from candidates c
)
select
  o.letter_id,
  o.contract_id,
  ct.contract_no,
  ct.customer_name,
  o.round,
  o.printed_at,
  o.episode_key,
  o.outcome,
  o.responded_at,
  case when o.responded_at is null then null
       else (o.responded_at at time zone 'Asia/Bangkok')::date
            - (o.printed_at   at time zone 'Asia/Bangkok')::date
  end as days_to_outcome
from outcomes o
join public.contracts ct on ct.id = o.contract_id;

create or replace view public.v_promise_attribution_30d
  with (security_invoker = on) as
with paid_events as (
  -- payment events ใน 30 วันล่าสุด (dedup by contract+date เพื่อกัน double-count
  --   กรณีชำระหลายงวดในวันเดียวกัน — นับ 1 event ต่อ contract ต่อ paid_date)
  select distinct
    pl.contract_id,
    (pl.created_at at time zone 'Asia/Bangkok')::date as paid_date
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
    ) -- (0180) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
    and pl.created_at >= now() - interval '30 days'
),
co_counts as (
  -- นับ distinct author per (contract_id, paid_date) ก่อน
  -- แยก CTE เพราะ Postgres ไม่รองรับ COUNT(DISTINCT) OVER() (SQLSTATE 0A000)
  -- predicate ต้องตรงกับ window_contacts ทุกบรรทัด (กัน denominator drift)
  select
    pe.contract_id,
    pe.paid_date,
    count(distinct f.author_id) as co_author_count
  from paid_events pe
  join public.follow_ups f
    on f.contract_id = pe.contract_id
    and f.follow_up_result = 'promised'
    and f.next_follow_up_at is not null                        -- match denominator (promises_agg)
    and f.created_at >= now() - interval '30 days'             -- match denominator (promises_agg)
    and (f.created_at at time zone 'Asia/Bangkok')::date
        between (pe.paid_date - interval '5 days')::date and pe.paid_date
  join public.profiles pr
    on pr.id = f.author_id
    and pr.role = 'freelancer'
  group by pe.contract_id, pe.paid_date
),
window_contacts as (
  -- หา freelancer ที่ promised บน contract เดียวกัน
  -- ใน window [paid_date - 5 วัน, paid_date]
  -- credit_share = 1/N แบ่งเท่ากันถ้าหลายคน promised บน contract+paid_date เดียวกัน
  -- เพิ่ม f.id as promise_id เพื่อระบุตัว promise (ใช้ใน promise_credits)
  select
    pe.contract_id,
    pe.paid_date,
    f.id      as promise_id,
    f.author_id,
    1.0 / cc.co_author_count as credit_share                  -- join CTE แทน window (no DISTINCT in window)
  from paid_events pe
  join co_counts cc
    on cc.contract_id = pe.contract_id
    and cc.paid_date = pe.paid_date
  join public.follow_ups f
    on f.contract_id = pe.contract_id
    and f.follow_up_result = 'promised'
    and f.next_follow_up_at is not null                        -- match denominator (promises_agg)
    and f.created_at >= now() - interval '30 days'             -- match denominator (promises_agg)
    and (f.created_at at time zone 'Asia/Bangkok')::date
        between (pe.paid_date - interval '5 days')::date and pe.paid_date
  join public.profiles pr
    on pr.id = f.author_id
    and pr.role = 'freelancer'
),
promise_credits as (
  -- aggregate ที่ระดับ promise (ไม่ใช่ contract+paid_date)
  -- 1 promise ได้ credit สูงสุด 1 ครั้ง ไม่ว่าจะมี payment กี่รอบใน 5-day window
  -- max(credit_share): promise เดียวกันอาจ match หลาย paid_date ที่มีชุด co-author ต่างกัน
  --   → credit_share ต่าง row อาจไม่เท่ากัน → max เลือกค่าสูงสุด (อย่างมาก 1.0/promise)
  --   → ยังการันตี ≤1.0 ต่อ promise → ratio ≤ 100% เสมอ
  select
    promise_id,
    author_id,
    max(credit_share) as credit_share
  from window_contacts
  group by promise_id, author_id
),
credit_agg as (
  -- รวม credit ต่อ author_id (จาก promise_credits แทน freelancer_credits เดิม)
  select
    author_id,
    count(*)::int                    as promises_kept_count,
    sum(credit_share)::numeric(10,2) as promises_kept_credit
  from promise_credits
  group by author_id
),
promises_agg as (
  -- denominator: promises ทั้งหมดใน 30 วัน ที่มี next_follow_up_at (OQ-A ไม่เปลี่ยน)
  select
    f.author_id,
    count(*)::int as promises_total
  from public.follow_ups f
  join public.profiles pr on pr.id = f.author_id and pr.role = 'freelancer'
  where f.follow_up_result = 'promised'
    and f.next_follow_up_at is not null
    and f.created_at >= now() - interval '30 days'
  group by f.author_id
)
-- FULL OUTER JOIN: กัน freelancer ที่มี promises แต่ไม่มี credit (หรือกลับกัน) หายไป
select
  coalesce(c.author_id, p.author_id)                        as author_id,
  coalesce(c.promises_kept_count, 0)                        as promises_kept_count,
  coalesce(c.promises_kept_credit, 0::numeric(10,2))        as promises_kept_credit,
  coalesce(p.promises_total, 0)                             as promises_total
from credit_agg c
full outer join promises_agg p on p.author_id = c.author_id;

create or replace function public.get_promise_attribution(p_days int default 30)
returns table (
  author_id            uuid,
  promises_kept_count  int,
  promises_kept_credit numeric,
  promises_total       int
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with _days as (
    select greatest(1, least(90, p_days)) as d
  ),
  paid_events as (
    -- payment events ใน p_days วันล่าสุด (dedup by contract+date)
    select distinct
      pl.contract_id,
      (pl.created_at at time zone 'Asia/Bangkok')::date as paid_date
    from public.payment_log pl
    cross join _days
    where pl.action = 'pay'
      and not (
        pl.installment_id is not null
        and exists (
          select 1 from public.payment_log c
          where c.action = 'cancel'
            and c.installment_id = pl.installment_id
            and c.created_at > pl.created_at
        )
      ) -- (0180) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
      and pl.created_at >= now() - (_days.d || ' days')::interval
  ),
  co_counts as (
    -- นับ distinct author per (contract_id, paid_date)
    select
      pe.contract_id,
      pe.paid_date,
      count(distinct f.author_id) as co_author_count
    from paid_events pe
    cross join _days
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.follow_up_result = 'promised'
      and f.next_follow_up_at is not null
      and f.created_at >= now() - (_days.d || ' days')::interval
      and (f.created_at at time zone 'Asia/Bangkok')::date
          between (pe.paid_date - interval '5 days')::date and pe.paid_date
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
    group by pe.contract_id, pe.paid_date
  ),
  window_contacts as (
    select
      pe.contract_id,
      pe.paid_date,
      f.id      as promise_id,
      f.author_id,
      1.0 / cc.co_author_count as credit_share
    from paid_events pe
    cross join _days
    join co_counts cc
      on cc.contract_id = pe.contract_id
      and cc.paid_date = pe.paid_date
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.follow_up_result = 'promised'
      and f.next_follow_up_at is not null
      and f.created_at >= now() - (_days.d || ' days')::interval
      and (f.created_at at time zone 'Asia/Bangkok')::date
          between (pe.paid_date - interval '5 days')::date and pe.paid_date
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
  ),
  promise_credits as (
    -- aggregate ที่ระดับ promise — 1 promise ได้ credit สูงสุด 1 ครั้ง
    select
      promise_id,
      author_id,
      max(credit_share) as credit_share
    from window_contacts
    group by promise_id, author_id
  ),
  credit_agg as (
    select
      author_id,
      count(*)::int                    as promises_kept_count,
      sum(credit_share)::numeric(10,2) as promises_kept_credit
    from promise_credits
    group by author_id
  ),
  promises_agg as (
    -- denominator: promises ทั้งหมดใน p_days วัน ที่มี next_follow_up_at
    select
      f.author_id,
      count(*)::int as promises_total
    from public.follow_ups f
    cross join _days
    join public.profiles pr on pr.id = f.author_id and pr.role = 'freelancer'
    where f.follow_up_result = 'promised'
      and f.next_follow_up_at is not null
      and f.created_at >= now() - (_days.d || ' days')::interval
    group by f.author_id
  )
  select
    coalesce(c.author_id, p.author_id)                        as author_id,
    coalesce(c.promises_kept_count, 0)                        as promises_kept_count,
    coalesce(c.promises_kept_credit, 0::numeric(10,2))        as promises_kept_credit,
    coalesce(p.promises_total, 0)                             as promises_total
  from credit_agg c
  full outer join promises_agg p on p.author_id = c.author_id;
$$;

create or replace function public.get_collector_call_outcomes(
  p_start date,
  p_end   date
)
returns table (
  author_id        uuid,
  author_name      text,
  cases_followed   int,
  cases_reached    int,
  cases_no_answer  int,
  cases_unreachable int,
  promises_made    int,
  promises_kept    int,
  promises_broken  int,
  promises_pending int
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- follow_ups ของ freelancer active ในช่วง (Bangkok date) — 1 scan ใช้ทั้ง case-counts + promise events
  fu as (
    select
      f.id,
      f.author_id,
      f.author_name,
      f.contract_id,
      f.follow_up_result,
      f.created_at,
      f.next_follow_up_at,
      f.promised_amount
    from public.follow_ups f
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  -- case-counts: ต่อ (author, contract) มีผลแบบ reached / no_answer ไหม
  -- (0119) ever_reached ใช้ list เดียวกับนิยาม "โทรติด" รวมของระบบ — เดิมตรงอยู่แล้ว ไม่เปลี่ยนผลลัพธ์
  case_rollup as (
    select
      author_id,
      contract_id,
      bool_or(follow_up_result in ('contacted','promised','paid','refused','returned')) as ever_reached,
      bool_or(follow_up_result = 'no_answer')                                            as ever_no_answer
    from fu
    group by author_id, contract_id
  ),
  case_metrics as (
    select
      author_id,
      count(*)::int                                                          as cases_followed,
      count(*) filter (where ever_reached)::int                              as cases_reached,
      count(*) filter (where ever_no_answer)::int                            as cases_no_answer,
      count(*) filter (where ever_no_answer and not ever_reached)::int       as cases_unreachable
    from case_rollup
    group by author_id
  ),
  -- (0119) promise_window: คำนวณยอดจ่ายจริงในหน้าต่าง (วันบันทึกนัด .. วันนัด+3 grace) ครั้งเดียว
  -- ต่อ promise event กัน correlated subquery ซ้ำ 2 รอบ
  promise_window as (
    select
      fu.id                                                                as follow_up_id,
      fu.author_id,
      fu.contract_id,
      (fu.next_follow_up_at at time zone 'Asia/Bangkok')::date + 3         as promise_grace_date,  -- วันนัด + 3 (grace)
      coalesce(fu.promised_amount, 0)                                      as promised_amount,
      coalesce((
        select sum(pl.amount)
        from public.payment_log pl
        where pl.contract_id = fu.contract_id
          and pl.action = 'pay'
          and not (
            pl.installment_id is not null
            and exists (
              select 1 from public.payment_log c
              where c.action = 'cancel'
                and c.installment_id = pl.installment_id
                and c.created_at > pl.created_at
            )
          ) -- (0180) ตัดแถว pay ที่ถูกยกเลิกภายหลัง (นิยามเดียวกับ 0178)
          and (pl.created_at at time zone 'Asia/Bangkok')::date
                between (fu.created_at        at time zone 'Asia/Bangkok')::date
                    and (fu.next_follow_up_at at time zone 'Asia/Bangkok')::date + 3
      ), 0)                                                                 as paid_in_window
    from fu
    where fu.follow_up_result = 'promised'
      and fu.next_follow_up_at is not null
  ),
  -- promise events: 1 row ต่อ "ครั้งที่นัด" — จัดประเภท kept / broken / pending แบบ mutually exclusive
  -- (0119) kept: promised_amount>0 → จ่ายรวม >= 80% ของยอดนัด ภายใน grace window
  --              promised_amount=0/null → fallback มีเงินเข้าเท่าไหร่ก็ได้ในช่วงเดียวกัน
  promise_events as (
    select
      pw.author_id,
      pw.contract_id,
      pw.promise_grace_date,
      case
        when pw.promised_amount > 0 then pw.paid_in_window >= pw.promised_amount * 0.8
        else pw.paid_in_window > 0
      end as kept
    from promise_window pw
  ),
  promise_metrics as (
    select
      author_id,
      count(*)::int                                                                                             as promises_made,
      count(*) filter (where kept)::int                                                                         as promises_kept,
      count(*) filter (where not kept and promise_grace_date <  (now() at time zone 'Asia/Bangkok')::date)::int as promises_broken,
      count(*) filter (where not kept and promise_grace_date >= (now() at time zone 'Asia/Bangkok')::date)::int as promises_pending
    from promise_events
    group by author_id
  ),
  -- ชื่อ author (max ต่อ author) จาก follow_ups ในช่วง
  names as (
    select author_id, max(author_name) as author_name
    from fu
    group by author_id
  )
  select
    coalesce(cm.author_id, pm.author_id)        as author_id,
    n.author_name                               as author_name,
    coalesce(cm.cases_followed, 0)              as cases_followed,
    coalesce(cm.cases_reached, 0)               as cases_reached,
    coalesce(cm.cases_no_answer, 0)             as cases_no_answer,
    coalesce(cm.cases_unreachable, 0)           as cases_unreachable,
    coalesce(pm.promises_made, 0)               as promises_made,
    coalesce(pm.promises_kept, 0)               as promises_kept,
    coalesce(pm.promises_broken, 0)             as promises_broken,
    coalesce(pm.promises_pending, 0)            as promises_pending
  from case_metrics cm
  full outer join promise_metrics pm on pm.author_id = cm.author_id
  left join names n on n.author_id = coalesce(cm.author_id, pm.author_id)
  where public.is_admin() or public.is_staff() or public.is_executive();   -- guard: freelancer/anon → 0 rows; exec เห็นได้ (no PII)
$$;

-- ============================================================================
-- Verify (ครีมรันหลัง apply) — SQL ตรงบนตาราง/catalog ไม่ต้องล็อกอิน
-- ============================================================================
-- 1) option/คอลัมน์ไม่เปลี่ยน:
-- SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--  WHERE n.nspname='public' AND c.relname IN ('v_letter_outcomes','v_promise_attribution_30d');
--   -- คาด: v_letter_outcomes reloptions NULL ; v_promise_attribution_30d {security_invoker=on}
-- 2) ฟังก์ชัน: prosecdef (get_promise_attribution=false, get_collector_call_outcomes=true) + มีเงื่อนไขตัด cancel:
-- SELECT p.proname, p.prosecdef, position('c.action = ''cancel''' in pg_get_functiondef(p.oid))>0 AS has_filter
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public' AND p.proname IN ('get_promise_attribution','get_collector_call_outcomes');
-- 3) view มีเงื่อนไข:
-- SELECT viewname, position('cancel' in definition)>0 AS has_filter FROM pg_views
--  WHERE schemaname='public' AND viewname IN ('v_letter_outcomes','v_promise_attribution_30d');
-- 4) ผลของ v_letter_outcomes ไม่ error + สรุป:
-- SELECT outcome, count(*) FROM public.v_letter_outcomes GROUP BY 1;
-- SELECT * FROM public.v_letter_outcome_summary;
-- 5) จดหมายที่ผลเปลี่ยน: จดหมายที่ "จ่ายครั้งแรกหลังส่ง" มีแค่ pay ที่ถูกยกเลิก (ควรเปลี่ยนจาก paid -> no_response/returned):
-- SELECT count(DISTINCT l.id) FROM public.collection_letters l
--  JOIN public.payment_log p ON p.contract_id=l.contract_id AND p.action='pay' AND p.created_at>l.printed_at
--  WHERE p.installment_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.payment_log c WHERE c.action='cancel'
--        AND c.installment_id=p.installment_id AND c.created_at>p.created_at);
-- 6) grants:
-- SELECT has_table_privilege('authenticated','public.v_letter_outcomes','SELECT'),
--        has_table_privilege('authenticated','public.v_promise_attribution_30d','SELECT'),
--        has_function_privilege('authenticated','public.get_promise_attribution(int)','EXECUTE'),
--        has_function_privilege('authenticated','public.get_collector_call_outcomes(date,date)','EXECUTE');
