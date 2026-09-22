-- 0163: สัญญา "รอเอกสาร" (pending_documents=true) ให้นับวันล่าช้าเหมือน PJ ไม่หยุดนับอีกต่อไป
--       (ป้าย "รอเอกสาร" ยังโชว์แยกบนหน้าเว็บเหมือนเดิม — mig นี้แก้แค่การนับวันล่าช้า/หนี้เสียเบื้องหลัง)
--
-- ============================================================================
-- ที่มา: คุณเตยตัดสินใจ 22 ก.ย. 2026 — ตอนนี้มี 10 สัญญารอเอกสาร ค้างจริง 4 ราย (2/39/48/70 วัน) แต่เว็บโชว์
-- days_late=0 ทุกราย (ตั้งแต่ 0049) เพราะทุก object ด้านล่าง suppress เป็น 0/'normal' เมื่อ pending_documents
-- =true โดยไม่สน next_due จริง → หลุดคิวตามหนี้ ลูกค้ากลุ่มนี้ไม่ถูกไล่ตามเหมือนสัญญาอื่น
--
-- นิยามฐาน: นิยามที่ apply จริงบน prod ตอนนี้มาจาก 0148 (ตรวจแล้ว 0149–0162 ไม่มีใครแก้ v_contract_status/
-- npl_as_of/npl_as_of_v2 อีกหลัง 0148/0159/0160 — grep "v_contract_status"/"npl_as_of" ยืนยันแล้ว)
--
-- เปลี่ยนแค่ 3 object (ตัดเงื่อนไข pending_documents ออก ให้ตกไปคำนวณจาก next_due/oldest_due จริงเหมือนสัญญา
-- ปกติ — ไม่แตะ logic/คอลัมน์อื่นแม้แต่ตัวอักษรเดียว):
--
--   1) public.v_contract_status — ลบ branch "when c.pending_documents = true then ..." ทั้ง 5 จุด:
--      days_late, bucket, อาร์กิวเมนต์ของ grade_for_days_late, overdue_amount, late_installments
--      (penalty_due / collectible_remaining / remaining_installments ไม่เคยถูก gate ด้วย pending_documents
--      อยู่แล้ว — ไม่ต้องแตะ)
--
--   2) public.npl_as_of(date) (0159) — CTE f: case เดิม
--      "when per.pending_documents or per.oldest_due is null then 0" → ตัด "per.pending_documents or" ออก
--      เหลือ "when per.oldest_due is null then 0" ให้ตรงกับ v_contract_status (กันกราฟ/การ์ดหนี้เสียรายวัน
--      เพี้ยนจาก view ที่คนหน้าเว็บเห็นจริง)
--
--   3) public.npl_as_of_v2(date) (0160) — CTE f เดียวกัน แก้เหมือนข้อ 2 (copy จาก npl_as_of ตาม pattern
--      เดิมของ 0160 ที่บอกไว้ว่า "CTE ชุดเดิมจาก 0159 ไม่ตัดทอน")
--
-- object อื่นที่ grep เจอคำว่า pending_documents (0049/0055/0090/0105/0126/0128/0130/0133/0148/0151/0153) เป็น
-- เวอร์ชันเก่าของ v_contract_status ที่ถูก 0148 แทนที่ไปแล้ว (create or replace ทับ) หรือไม่เกี่ยวกับวันล่าช้า
-- (0105/0151 = set ค่า false ตอนสรุปยอด, 0153 = deny-list เช็คสิทธิ์แก้คอลัมน์) — ไม่ต้องแตะ ไม่มีผลซ้ำซ้อน
--
-- signature / security definer / search_path / grant / revoke ของทั้ง 3 object คงเดิมทุกตัวอักษร — ใช้
-- CREATE OR REPLACE ทั้งหมด (v_contract_status ต้องคง security_invoker=on ตาม 0018 ไม่งั้น freelancer RLS พัง)
-- ============================================================================


-- ============================================================================
-- SECTION 1: v_contract_status — ตัด pending_documents suppress ออก 5 จุด (ที่เหลือ copy เป๊ะจาก 0148)
-- ============================================================================

create or replace view public.v_contract_status
  with (security_invoker = on) as
with agg as (
  select
    i.contract_id,
    min(i.due_date) filter (where i.paid_at is null)                        as next_due,
    -- penalty_due: ไม่เคย gate ด้วย pending_documents อยู่แล้ว (0148) — ไม่แตะ
    coalesce(
      sum(
        case
          when coalesce(i.penalty_amount, 0) > 0
            then greatest(0::numeric, i.penalty_amount - public.penalty_paid_for_installment(i.id))
          else 0::numeric
        end
      ),
      0::numeric
    )                                                                        as penalty_due,
    count(*) filter (where i.paid_at is null)                               as remaining_installments,
    coalesce(
      sum(i.amount - coalesce(i.paid_amount, 0))
        filter (where i.paid_at is null and i.due_date <= current_date),
      0::numeric
    )                                                                        as overdue_principal,
    count(*) filter (where i.paid_at is not null)                           as paid_installments_count,
    coalesce(sum(i.paid_amount), 0::numeric)                                as paid_amount_sum,
    count(*) filter (where i.paid_at is null and i.due_date < current_date) as late_installments_count
  from installments i
  group by i.contract_id
),
oldest_unpaid as (
  select distinct on (i.contract_id)
         i.contract_id,
         i.due_date                                          as oldest_unpaid_due_date,
         greatest(i.amount - coalesce(i.paid_amount, 0), 0) as oldest_unpaid_amount,
         coalesce(i.penalty_amount, 0)                       as oldest_unpaid_penalty
  from installments i
  where i.paid_at is null
  order by i.contract_id, i.due_date asc
),
latest_return as (
  select distinct on (dr.contract_id)
         dr.contract_id,
         dr.created_at as return_date,
         dr.repair_cost,
         dr.repair_fee
  from device_returns dr
  order by dr.contract_id, dr.created_at desc
)
select
  c.id                                                                       as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name                                                                     as shop_name,
  c.status,
  a.next_due,
  coalesce(a.remaining_installments, 0)                                      as remaining_installments,
  coalesce(a.penalty_due, 0)                                                 as penalty_due,
  -- days_late: 0163 — ตัด branch pending_documents ออก (นับวันล่าช้าจริงเหมือน PJ ไม่ suppress อีกต่อไป)
  case
    when c.status not in ('active','returned') or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end                                                                        as days_late,
  -- bucket: 0163 — ตัด branch pending_documents ออก
  case
    when c.status not in ('active','returned') or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10                        then '1-10'
    when current_date - a.next_due <= 30                        then '11-30'
    when current_date - a.next_due <= 60                        then '31-60'
    when current_date - a.next_due <= 90                        then '61-90'
    when current_date - a.next_due <= 120                       then '91-120'
    else '120+'
  end                                                                        as bucket,
  -- grade: 0163 — ตัด branch pending_documents ออกจากอาร์กิวเมนต์ (ใช้ days_late จริง)
  grade_for_days_late(
    case
      when c.status not in ('active','returned') or a.next_due is null then 0
      else greatest(0, (current_date - a.next_due))
    end
  )                                                                          as grade,
  coalesce(c.monthly_payment, 0) * coalesce(a.remaining_installments, 0)   as est_outstanding,
  -- overdue_amount: 0163 — ตัด branch pending_documents ออก
  case
    when c.status not in ('active','returned') or a.next_due is null then 0::numeric
    else coalesce(a.overdue_principal, 0::numeric)
  end                                                                        as overdue_amount,
  coalesce(a.paid_installments_count, 0)                                     as paid_installments,
  coalesce(a.paid_amount_sum, 0::numeric)                                    as paid_amount_total,
  -- late_installments: 0163 — ตัด branch pending_documents ออก
  case
    when c.status not in ('active','returned') or a.next_due is null then 0
    else coalesce(a.late_installments_count, 0)
  end                                                                        as late_installments,
  c.inv_no                                                                   as inv_no,
  c.model                                                                    as model,
  c.storage                                                                  as storage,
  c.term_months                                                              as term_months,
  -- collectible_remaining: ไม่เคย gate ด้วย pending_documents — ไม่แตะ (copy เป๊ะจาก 0148/0133)
  case
    when c.status in ('returned', 'returned_closed') then
      case
        when lr.return_date is not null
          and (lr.return_date at time zone 'Asia/Bangkok')::date >= '2026-07-02'::date
          and ou.oldest_unpaid_due_date is not null
          and ou.oldest_unpaid_due_date > (lr.return_date at time zone 'Asia/Bangkok')::date
        then 0
        else coalesce(ou.oldest_unpaid_amount, 0) + coalesce(ou.oldest_unpaid_penalty, 0)
      end
        + coalesce(lr.repair_cost, lr.repair_fee, 0)
    else null
  end                                                                        as collectible_remaining
from contracts c
left join agg a           on a.contract_id = c.id
left join shops_basic s   on s.id = c.shop_id
left join oldest_unpaid ou on ou.contract_id = c.id
left join latest_return lr on lr.contract_id = c.id;

-- CREATE OR REPLACE คง grant เดิมจาก 0049/0055/0090/0126/0128/0130/0133/0148 อยู่แล้ว แต่ใส่ไว้เพื่อความปลอดภัย
grant select on public.v_contract_status to authenticated;
grant select on public.v_contract_status to service_role;


-- ============================================================================
-- SECTION 2: npl_as_of(date) (0159) — ตัด pending_documents ออกจาก dl case ให้ตรงกับ v_contract_status
-- (copy ทั้งฟังก์ชันจาก 0159 เป๊ะ แก้เฉพาะบรรทัด case ของ CTE f)
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
    select contract_id, max((created_at at time zone 'Asia/Bangkok')::date) as rdate
    from public.device_returns
    group by contract_id
  ),
  logs as (
    select contract_id, installment_id, (created_at at time zone 'Asia/Bangkok')::date as ld, amount
    from public.payment_log
    where action = 'pay' and created_at >= timestamptz '2026-06-01'
  ),
  fut as (
    select distinct contract_id from logs where ld > v_today
  ),
  la_inst as (
    select installment_id, sum(amount) as amt
    from logs
    where ld > p_date and ld <= v_today
    group by installment_id
  ),
  la_con as (
    select distinct contract_id
    from logs
    where ld > p_date and ld <= v_today
  ),
  open_at as (
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
    -- 0163: ตัด "per.pending_documents or" ออก — รอเอกสารไม่ suppress วันล่าช้าอีกต่อไป (ตรงกับ v_contract_status)
    select per.*,
      case when per.oldest_due is null then 0
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
  '(0159/0163) คำนวณหนี้เสีย (days_late>=60, สัญญาเปิดอยู่) ณ วันใดก็ได้ จากข้อมูลปัจจุบัน — สูตรเดียวกับ kpiBadDebt60/buildBucketKpi (src/lib/monthlyReport.ts) ณ p_date=วันนี้; หักเงินที่จ่ายหลัง p_date คืนเพื่อจำลองยอดคงเหลือย้อนหลัง; "วันนี้" อ้างอิง Asia/Bangkok เสมอ; 0163: pending_documents ไม่ suppress วันล่าช้าอีกต่อไป (ตรงกับ v_contract_status); service_role เท่านั้น (engine ภายใน — authenticated เรียกผ่าน get_npl_history/record_npl_snapshot)';


-- ============================================================================
-- SECTION 3: npl_as_of_v2(date) (0160) — ตัด pending_documents ออกจาก dl case เหมือน SECTION 2
-- (copy ทั้งฟังก์ชันจาก 0160 เป๊ะ แก้เฉพาะบรรทัด case ของ CTE f)
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
    select contract_id, max((created_at at time zone 'Asia/Bangkok')::date) as rdate
    from public.device_returns
    group by contract_id
  ),
  logs as (
    select contract_id, installment_id, (created_at at time zone 'Asia/Bangkok')::date as ld, amount
    from public.payment_log
    where action = 'pay' and created_at >= timestamptz '2026-06-01'
  ),
  fut as (
    select distinct contract_id from logs where ld > v_today
  ),
  la_inst as (
    select installment_id, sum(amount) as amt
    from logs
    where ld > p_date and ld <= v_today
    group by installment_id
  ),
  la_con as (
    select distinct contract_id
    from logs
    where ld > p_date and ld <= v_today
  ),
  open_at as (
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
    -- 0163: ตัด "per.pending_documents or" ออก — รอเอกสารไม่ suppress วันล่าช้าอีกต่อไป (ตรงกับ v_contract_status)
    select per.*,
      case when per.oldest_due is null then 0
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
  '(0160/0163) เหมือน npl_as_of(date) ทุกจุด (สูตร/ขอบเขตสัญญาเดียวกัน) + คำนวณ overdue_count/overdue_outstanding (days_late>=1) เพิ่มในรอบเดียวกัน ไม่รัน query หนักซ้ำ — 0163: pending_documents ไม่ suppress วันล่าช้าอีกต่อไป (ตรงกับ v_contract_status); npl_as_of เดิมคงไว้ไม่แตะ (คนอื่นอาจเรียกอยู่); service_role เท่านั้น (engine ภายใน — authenticated เรียกผ่าน get_npl_history/record_npl_snapshot)';


-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply (ห้ามข้าม)
-- ============================================================================

-- 0) ก่อน apply: เก็บ baseline ของ 4 เคสที่รู้ว่าค้างจริง (2/39/48/70 วัน) — days_late ต้องเป็น 0 ทุกแถว (บั๊กเดิม):
-- SELECT contract_no, status, pending_documents, next_due, days_late, bucket, overdue_amount, late_installments
--   FROM public.v_contract_status
--   WHERE contract_id IN (SELECT id FROM public.contracts WHERE pending_documents = true)
--   ORDER BY contract_no;

-- 1) columns ยังครบเท่าเดิม (22 ตัวตาม 0148 — ไม่ใช่ 29, เช็ค ordinal_position ให้ตรงลำดับ 0148 ด้วย):
-- SELECT column_name, ordinal_position FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='v_contract_status' ORDER BY ordinal_position;

-- 2) security_invoker + grants ยังอยู่ครบ:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_contract_status';
-- SELECT has_table_privilege('authenticated', 'public.v_contract_status', 'SELECT');
-- SELECT has_table_privilege('service_role',  'public.v_contract_status', 'SELECT');

-- 3) หลัง apply: 10 สัญญารอเอกสารต้องเห็น days_late/bucket/overdue_amount/late_installments ขยับตาม next_due จริง
--    (4 เคสที่รู้ล่วงหน้า ต้องได้ 2/39/48/70 วัน ตามลำดับ ไม่ใช่ 0 อีกต่อไป) — รัน query เดียวกับข้อ 0 เทียบผล

-- 4) ทุกคอลัมน์อื่น (ที่ไม่ใช่ 5 จุดที่แก้) ของสัญญาที่ pending_documents=false ต้องไม่ขยับแม้แต่ค่าเดียว
--    (เทียบ snapshot ก่อน/หลังของสัญญากลุ่มนี้ — ควรเหมือนเดิม 100% เพราะ CASE เดิม evaluate เหมือนกันทุก
--    branch ยกเว้น branch pending_documents ที่ถูกลบไป ซึ่งไม่ถูกกระทบสัญญากลุ่มนี้อยู่แล้ว):
-- SELECT contract_id, contract_no, days_late, bucket, grade, overdue_amount, late_installments
--   FROM public.v_contract_status WHERE status IN ('active','returned') AND
--   contract_id NOT IN (SELECT id FROM public.contracts WHERE pending_documents = true)
--   ORDER BY contract_id;

-- 5) npl_as_of / npl_as_of_v2 ตรงสิทธิ์เดิม (ไม่เปลี่ยน):
-- SELECT has_function_privilege('service_role', 'public.npl_as_of(date)', 'EXECUTE');    -- true
-- SELECT has_function_privilege('authenticated', 'public.npl_as_of(date)', 'EXECUTE');    -- false
-- SELECT has_function_privilege('service_role', 'public.npl_as_of_v2(date)', 'EXECUTE');  -- true
-- SELECT has_function_privilege('authenticated', 'public.npl_as_of_v2(date)', 'EXECUTE');  -- false

-- 6) ตัวเลขหนี้เสียรายวันสดวันนี้ ต้องเปลี่ยนตามสัญญารอเอกสารที่ค้าง >=60 วัน (ถ้ามีในกลุ่ม 4 เคสที่รู้ — เคส
--    70 วันเข้าเกณฑ์ bad, เคส 48 วันยังไม่เข้า):
-- SELECT * FROM public.npl_as_of((now() at time zone 'Asia/Bangkok')::date);
-- SELECT * FROM public.npl_as_of_v2((now() at time zone 'Asia/Bangkok')::date);

-- 7) เทียบ v_contract_status กับ v_device_return_report ยังตรงกันทุกเคส returned/returned_closed (0163 ไม่ได้
--    แตะ collectible_remaining เลย — เช็คซ้ำกันพลาด เหมือน checklist ข้อ 6 ของ 0148):
-- SELECT vcs.contract_no, vcs.collectible_remaining AS vcs_val, vdr.collectible_remaining AS vdr_val
--   FROM public.v_contract_status vcs
--   JOIN public.v_device_return_report vdr ON vdr.contract_id = vcs.contract_id
--   WHERE vcs.collectible_remaining IS DISTINCT FROM vdr.collectible_remaining;
-- expected: 0 rows
