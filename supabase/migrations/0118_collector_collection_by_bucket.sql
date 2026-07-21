-- 0118: RPC ใหม่ get_collector_collection_by_bucket — ยอดเก็บเงินของคนโทร แยกตาม "วันช้า ณ วันที่จ่าย"
-- Pete ต้องการดูว่าคนโทรแต่ละคนเก็บเงินจากลูกหนี้ช่วงไหน (ตรงเวลา / ค้าง 1-10 / 11-30 / ... / 120+)
-- ระวัง: "วันช้า" ในตารางนี้ต้องคิด ณ ตอนจ่ายจริง (paid_date − installments.due_date) — ไม่ใช่ bucket ปัจจุบัน
-- ของ v_contract_status (นั่นคือสถานะ ณ วันนี้ ของสัญญา ไม่ใช่ ณ วันที่จ่ายงวดนั้น)
--
-- การให้เครดิตคนโทร (ใครควรได้เครดิตยอดที่จ่าย) copy CTE จาก 0098 (get_collector_scorecard) มาเป๊ะ:
--   last-touch attribution — สายโทร (contact_method='phone') ของ freelancer active ที่เกิดก่อนวันจ่าย
--   ไม่เกิน 7 วัน ผู้ชนะคือสายล่าสุดก่อนจ่าย (distinct on ... order by created_at desc, id desc)
--   → เพื่อให้ cross-check ได้ว่า SUM(collected_baht) ทุก bucket ของแต่ละคน เท่ากับยอดเก็บจากโทรใน
--     get_collector_scorecard แบบบาทต่อบาท (ดู smoke query ท้ายไฟล์)
--
-- join installments ผ่าน payment_log.installment_id แบบ LEFT JOIN เสมอ — ถ้า link เป็น null (งวดถูกลบ
-- ตอนขยาย/ปรับโครงสร้างสัญญา — payment_log.installment_id เป็น on delete set null ตาม 0011) หรือ due_date
-- เป็น null → bucket 'ไม่ทราบช่วง' (ห้ามทิ้งแถวเงียบ ไม่งั้นยอดรวมจะไม่ตรงกับ scorecard)
--
-- aggregate เสร็จใน SQL (group by author+bucket) — คืนแค่ ≤ 8 แถวต่อคน (7 bucket + ไม่ทราบช่วง) ไม่คืน raw rows
--
-- additive only: create or replace function ใหม่ ไม่แตะตาราง/ฟังก์ชันอื่น
-- guard เหมือน 0097/0098: is_admin() or is_staff() or is_executive() — ไม่มี PII ลูกค้า (แค่ author + ตัวเลข)

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

grant execute on function public.get_collector_collection_by_bucket(date, date)
  to authenticated, service_role;

comment on function public.get_collector_collection_by_bucket(date, date) is
  'ยอดเก็บเงินของคนโทรแยกตามช่วงวันช้า ณ วันจ่ายจริง (paid_date - due_date) ไม่ใช่ bucket ปัจจุบันของสัญญา; last-touch attribution เหมือน get_collector_scorecard (0098) เป๊ะ; link ขาด/due_date null -> bucket ไม่ทราบช่วง (ไม่ทิ้งแถว)';

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 1) ตรวจ grant:
-- SELECT has_function_privilege('authenticated', 'public.get_collector_collection_by_bucket(date,date)', 'EXECUTE'); -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_collection_by_bucket(date,date)', 'EXECUTE'); -- true

-- 2) รันได้ไม่ error (1 เดือนจริง):
-- SELECT * FROM public.get_collector_collection_by_bucket('2026-06-01','2026-06-30') ORDER BY author_name, bucket;

-- 3) CROSS-CHECK สำคัญที่สุด: SUM(collected_baht) ทุก bucket ต่อคน ต้องเท่ากับผลรวม collected_baht
--    ต่อคนจาก get_collector_scorecard (ทุกเกรดรวมกัน) แบบบาทต่อบาท — ถ้าไม่ตรง = copy CTE ผิด
-- WITH bucket_sum AS (
--   SELECT author_id, SUM(collected_baht) AS total
--   FROM public.get_collector_collection_by_bucket('2026-06-01','2026-06-30')
--   GROUP BY author_id
-- ),
-- score_sum AS (
--   SELECT author_id, SUM(collected_baht) AS total
--   FROM public.get_collector_scorecard('2026-06-01','2026-06-30')
--   GROUP BY author_id
-- )
-- SELECT coalesce(b.author_id, s.author_id) AS author_id,
--        coalesce(b.total, 0) AS bucket_total,
--        coalesce(s.total, 0) AS scorecard_total,
--        coalesce(b.total, 0) - coalesce(s.total, 0) AS diff
-- FROM bucket_sum b
-- FULL OUTER JOIN score_sum s ON s.author_id = b.author_id
-- WHERE coalesce(b.total, 0) <> coalesce(s.total, 0);
-- -- expected: 0 rows

-- 4) sanity: ไม่มี bucket แปลกปลอมนอกลิสต์ที่กำหนด:
-- SELECT DISTINCT bucket FROM public.get_collector_collection_by_bucket('2026-06-01','2026-06-30');
-- -- expected เฉพาะ: ตรงเวลา, 1-10, 11-30, 31-60, 61-90, 91-120, 120+, ไม่ทราบช่วง

-- 5) freelancer เรียกแล้วเห็น 0 rows (guard กันอยู่) — ทดสอบด้วย token freelancer ผ่าน REST
