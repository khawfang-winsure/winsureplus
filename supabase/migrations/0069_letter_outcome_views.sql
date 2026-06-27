-- 0069: views "วัดผลจดหมายติดตามหนี้" (collection_letters → 3 aggregate views)
-- คำนวณ auto จากข้อมูล (ไม่มี trigger / ไม่มีคอลัมน์เก็บผล) ว่าส่งจดหมายแล้วลูกค้า
-- จ่าย/คืนเครื่อง กี่ % — ใช้บนหน้ารายงานผู้บริหาร (admin)

-- ============================================================================
-- นิยาม "ผลลัพธ์ต่อจดหมาย 1 ฉบับ" (attribution = ให้เครดิตจดหมายฉบับล่าสุดก่อนจ่าย)
--
--   next_letter_at = printed_at ของจดหมายฉบับถัดไปของสัญญาเดียวกัน
--       (lead(printed_at) over (partition by contract_id order by printed_at))
--
--   first_pay_at    = min(payment_log.created_at) ของสัญญานั้น
--                     ที่ action='pay' AND created_at > printed_at
--   first_return_at = min(device_returns.created_at) ของสัญญานั้น
--                     ที่ created_at > printed_at
--
--   นับให้จดหมายฉบับนี้ก็ต่อเมื่อเกิด "ก่อน" จดหมายฉบับถัดไป (ถ้าไม่มีฉบับถัดไป
--   = next_letter_at is null → นับได้เสมอ):
--       cand_pay    = first_pay_at    ถ้า (next_letter_at is null OR first_pay_at    < next_letter_at)
--       cand_return = first_return_at ถ้า (next_letter_at is null OR first_return_at < next_letter_at)
--
--   outcome:
--     - เอาเวลาที่ "เร็วกว่า" ระหว่าง cand_pay กับ cand_return เป็นการตอบสนอง
--     - ถ้าการตอบสนอง = การจ่าย   → 'paid'
--     - ถ้าการตอบสนอง = คืนเครื่อง → 'returned'
--     - ถ้าไม่มีทั้งคู่              → 'no_response'
--   responded_at   = เวลาที่ตอบสนอง (null ถ้า no_response)
--   days_to_outcome = (responded_at::date - printed_at::date) ตามเขต Asia/Bangkok
--
-- effectiveness % คำนวณใน view summary/by_round เลย (paid+returned)/total
--
-- pattern grant: ตามโปรเจกต์ (0057/0059/0066/0067) — view ธรรมดา ไม่ใช้ security_invoker
--   create or replace view + grant select to authenticated, service_role
--   (admin gate ทำที่ frontend/route; base table collection_letters/payment_log
--    /device_returns มี RLS อยู่แล้ว แต่ view ไม่สืบ RLS — รายงานนี้เปิดให้
--    authenticated อ่าน aggregate ได้ ตาม pattern view อื่นในโปรเจกต์)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) v_letter_outcomes — 1 แถว/จดหมาย (base ของ summary/by_round + drill-down)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 2) v_letter_outcome_summary — 1 แถว รวมทุกฉบับ
-- ----------------------------------------------------------------------------
create or replace view public.v_letter_outcome_summary as
select
  count(*)                                              as total_letters,
  count(*) filter (where outcome = 'paid')             as paid_count,
  count(*) filter (where outcome = 'returned')         as returned_count,
  count(*) filter (where outcome = 'no_response')      as no_response_count,
  count(*) filter (where outcome in ('paid','returned')) as effective_count,
  coalesce(round(
    count(*) filter (where outcome in ('paid','returned')) * 100.0
    / nullif(count(*), 0)
  ), 0)::int                                            as effectiveness_pct,
  coalesce(round(
    avg(days_to_outcome) filter (where outcome <> 'no_response')
  ), 0)::int                                            as avg_days_to_outcome
from public.v_letter_outcomes;

-- ----------------------------------------------------------------------------
-- 3) v_letter_outcome_by_round — 1 แถว/round (1,2,3)
-- ----------------------------------------------------------------------------
create or replace view public.v_letter_outcome_by_round as
select
  round,
  count(*)                                              as total_letters,
  count(*) filter (where outcome = 'paid')             as paid_count,
  count(*) filter (where outcome = 'returned')         as returned_count,
  count(*) filter (where outcome = 'no_response')      as no_response_count,
  count(*) filter (where outcome in ('paid','returned')) as effective_count,
  coalesce(round(
    count(*) filter (where outcome in ('paid','returned')) * 100.0
    / nullif(count(*), 0)
  ), 0)::int                                            as effectiveness_pct,
  coalesce(round(
    avg(days_to_outcome) filter (where outcome <> 'no_response')
  ), 0)::int                                            as avg_days_to_outcome
from public.v_letter_outcomes
group by round
order by round;

-- ============================================================================
-- GRANT — views ต้อง grant ตรง (0017 default privileges ไม่ครอบ views)
-- re-grant idempotent หลัง create or replace (ตาม pattern 0057/0059/0066/0067)
-- ============================================================================
grant select on public.v_letter_outcomes          to authenticated, service_role;
grant select on public.v_letter_outcome_summary    to authenticated, service_role;
grant select on public.v_letter_outcome_by_round   to authenticated, service_role;

-- ============================================================================
-- Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================
-- a) grants ครบ:
--   select has_table_privilege('authenticated','public.v_letter_outcome_summary','SELECT');  -- true
--   select has_table_privilege('service_role','public.v_letter_outcome_by_round','SELECT');  -- true
--
-- b) ตอนนี้ collection_letters = 0 แถว → 3 views จะว่าง/ศูนย์:
--   select * from v_letter_outcomes;            -- 0 แถว
--   select * from v_letter_outcome_summary;     -- total_letters=0, effectiveness_pct=0, avg=0
--   select * from v_letter_outcome_by_round;    -- 0 แถว
--
-- ----------------------------------------------------------------------------
-- c) VALIDATION (จำลอง logic ด้วย VALUES — ไม่แตะตารางจริง) — copy ไปรันได้เลย
--    พิสูจน์ 4 เคส: paid / no_response (จ่ายหลังจดหมายถัดไป) / returned / round-2 paid
--
--    สมมติ 1 สัญญา ส่งจดหมาย 3 ฉบับ:
--      L1 round1 printed 2026-01-01  -> มีจ่าย 2026-01-05 (ก่อน L2)        => paid (days=4)
--      L2 round2 printed 2026-02-01  -> มีจ่าย 2026-03-10 (หลัง L3!)        => no_response
--      L3 round3 printed 2026-03-01  -> มีคืนเครื่อง 2026-03-05 (ไม่มีฉบับถัดไป) => returned (days=4)
--    และอีก 1 สัญญา:
--      L4 round2 printed 2026-04-01  -> มีจ่าย 2026-04-02 (ไม่มีฉบับถัดไป)  => paid (days=1)  [round-2 paid]
--
-- with letters(letter_id, contract_id, round, printed_at) as (values
--   (1, 'A', 1, timestamptz '2026-01-01 09:00+07'),
--   (2, 'A', 2, timestamptz '2026-02-01 09:00+07'),
--   (3, 'A', 3, timestamptz '2026-03-01 09:00+07'),
--   (4, 'B', 2, timestamptz '2026-04-01 09:00+07')
-- ),
-- pays(contract_id, created_at) as (values
--   ('A', timestamptz '2026-01-05 10:00+07'),   -- ตอบ L1
--   ('A', timestamptz '2026-03-10 10:00+07'),   -- หลัง L3 -> ไม่นับให้ L2
--   ('B', timestamptz '2026-04-02 10:00+07')    -- ตอบ L4
-- ),
-- returns(contract_id, created_at) as (values
--   ('A', timestamptz '2026-03-05 10:00+07')    -- ตอบ L3
-- ),
-- lt as (
--   select *, lead(printed_at) over (partition by contract_id order by printed_at) as next_letter_at
--   from letters
-- ),
-- resolved as (
--   select lt.*,
--     (select min(p.created_at) from pays p
--       where p.contract_id = lt.contract_id and p.created_at > lt.printed_at) as first_pay_at,
--     (select min(r.created_at) from returns r
--       where r.contract_id = lt.contract_id and r.created_at > lt.printed_at) as first_return_at
--   from lt
-- ),
-- cand as (
--   select *,
--     case when first_pay_at is not null and (next_letter_at is null or first_pay_at < next_letter_at)
--          then first_pay_at end as cand_pay,
--     case when first_return_at is not null and (next_letter_at is null or first_return_at < next_letter_at)
--          then first_return_at end as cand_return
--   from resolved
-- )
-- select letter_id, contract_id, round,
--   least(cand_pay, cand_return) as responded_at,
--   case
--     when cand_pay is null and cand_return is null then 'no_response'
--     when cand_return is null then 'paid'
--     when cand_pay is null then 'returned'
--     when cand_pay <= cand_return then 'paid'
--     else 'returned'
--   end as outcome
-- from cand order by letter_id;
--
--   ผลคาดหวัง:
--     letter_id=1 (A,r1) -> outcome='paid'        responded_at=2026-01-05
--     letter_id=2 (A,r2) -> outcome='no_response' responded_at=null
--     letter_id=3 (A,r3) -> outcome='returned'    responded_at=2026-03-05
--     letter_id=4 (B,r2) -> outcome='paid'        responded_at=2026-04-02
--
--   สรุปแบบ summary คาดหวัง: total=4, paid=2, returned=1, no_response=1,
--     effective=3, effectiveness_pct=round(3*100/4)=75
