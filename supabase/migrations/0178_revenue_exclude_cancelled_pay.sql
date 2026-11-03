-- 0178: รายได้ไม่นับแถวจ่ายเงิน (payment_log action='pay') ที่ถูกยกเลิกภายหลัง (v_cashflow_daily + v_payment_summary)
-- ปัญหา: cancel_payment รีเซ็ตงวดแล้ว insert แถว action='cancel' amount=0 แต่ไม่ลบแถว 'pay' เดิม
--        view ทั้งสองรวม sum(amount) ทุก 'pay' → ยอดที่ยกเลิกแล้วยังถูกนับเป็นรายได้ (ผลจริง 28 แถว 53,664 บาท 16 สัญญา)
-- กติกา: แถว 'pay' ที่มี installment_id และมีแถว 'cancel' ของงวดเดียวกันที่ created_at "มากกว่า" (>) แถว pay นั้น = ถูกยกเลิก ไม่นับ
--        ใช้ > เท่านั้น: เคส Data Fix ที่ cancel กับ pay ใหม่ timestamp เท่ากันเป๊ะ → แถว pay ใหม่ยังต้องนับ
--        แถว pay ที่ installment_id เป็น null (เงินดาวน์ ฯลฯ) นับเหมือนเดิม
-- ปลอดภัย: ไม่ลบ/ไม่แก้ข้อมูลใน payment_log (ประวัติครบ) — แก้เฉพาะนิยาม view; คอลัมน์/ลำดับ/ชนิดเดิมทุกตัว
--        ไม่เพิ่ม at time zone ใหม่ (v_cashflow_daily ใช้ Asia/Bangkok เดิมของ 0056)

-- index ช่วย exists: ค้นแถว cancel ตามงวด+เวลา (partial เฉพาะ cancel → เล็กมาก)
create index if not exists payment_log_cancel_inst_created_idx
  on public.payment_log (installment_id, created_at)
  where action = 'cancel';

-- ---------------------------------------------------------------------------
-- v_cashflow_daily (นิยามเดิม 0056: pay_date, income, penalty_income, pay_count)
-- ---------------------------------------------------------------------------
create or replace view public.v_cashflow_daily as
select
  (pl.created_at at time zone 'Asia/Bangkok')::date   as pay_date,
  sum(pl.amount)                                       as income,
  sum(coalesce(pl.penalty_paid_amount, 0))             as penalty_income,
  count(*)                                             as pay_count
from public.payment_log pl
where pl.action = 'pay'
  and not (
    pl.installment_id is not null
    and exists (
      select 1
      from public.payment_log c
      where c.action = 'cancel'
        and c.installment_id = pl.installment_id
        and c.created_at > pl.created_at
    )
  )
group by (pl.created_at at time zone 'Asia/Bangkok')::date
order by pay_date;

-- ---------------------------------------------------------------------------
-- v_payment_summary (นิยามเดิม 0039: contract_id, pay_count, total_pay, last_pay_at)
-- group by contract_id ทุก action เหมือนเดิม — เปลี่ยนเฉพาะเงื่อนไข filter ของ pay
-- ---------------------------------------------------------------------------
create or replace view public.v_payment_summary as
select
  pl.contract_id,
  count(*)          filter (where pl.action = 'pay' and not v.voided)                 as pay_count,
  coalesce(sum(pl.amount) filter (where pl.action = 'pay' and not v.voided), 0)       as total_pay,
  max(pl.created_at) filter (where pl.action = 'pay' and not v.voided)                as last_pay_at
from public.payment_log pl
cross join lateral (
  select (
    pl.action = 'pay'
    and pl.installment_id is not null
    and exists (
      select 1
      from public.payment_log c
      where c.action = 'cancel'
        and c.installment_id = pl.installment_id
        and c.created_at > pl.created_at
    )
  ) as voided
) v
group by pl.contract_id;

-- CREATE OR REPLACE คง grant เดิม แต่ใส่ซ้ำให้ชัดเจน (pattern 0055/0056)
grant select on public.v_cashflow_daily  to authenticated, service_role;
grant select on public.v_payment_summary to authenticated, service_role;

-- ============================================================================
-- Verify (ครีมรันหลัง apply)
-- ============================================================================
-- 1) จำนวนแถวที่ถูกตัด (คาด 28 แถว / 53,664 บาท / 16 สัญญา ณ วันตรวจ):
-- SELECT count(*), sum(p.amount), count(distinct p.contract_id)
--   FROM public.payment_log p
--  WHERE p.action='pay' AND p.installment_id IS NOT NULL
--    AND EXISTS (SELECT 1 FROM public.payment_log c WHERE c.action='cancel'
--                AND c.installment_id=p.installment_id AND c.created_at>p.created_at);
-- 2) ยอดรวม view = pay ทั้งหมด - ที่ถูกตัด:
-- SELECT (SELECT sum(amount) FROM public.payment_log WHERE action='pay') AS raw_pay,
--        (SELECT sum(income) FROM public.v_cashflow_daily)  AS cashflow,
--        (SELECT sum(total_pay) FROM public.v_payment_summary) AS summary;
--   -- cashflow ต้อง = summary และ raw_pay - cashflow = ยอดข้อ 1
-- 3) ลดลงรายเดือน (คาด ก.ค. 2,899 · ส.ค. 14,276 · ก.ย. 8,874 · ต.ค. 24,010 · พ.ย. 3,605):
-- SELECT to_char((p.created_at at time zone 'Asia/Bangkok'),'YYYY-MM') m, sum(p.amount)
--   FROM public.payment_log p
--  WHERE p.action='pay' AND p.installment_id IS NOT NULL
--    AND EXISTS (SELECT 1 FROM public.payment_log c WHERE c.action='cancel'
--                AND c.installment_id=p.installment_id AND c.created_at>p.created_at)
--  GROUP BY 1 ORDER BY 1;
-- 4) เคส timestamp เท่ากัน (Data Fix) ต้องยังนับ: แถว pay ที่มี cancel created_at = เท่ากันเป๊ะ ต้องไม่อยู่ในข้อ 1
-- 5) grants:
-- SELECT has_table_privilege('authenticated','public.v_cashflow_daily','SELECT'),
--        has_table_privilege('service_role','public.v_cashflow_daily','SELECT'),
--        has_table_privilege('authenticated','public.v_payment_summary','SELECT'),
--        has_table_privilege('service_role','public.v_payment_summary','SELECT');
-- 6) นิยามสดของ view ที่ยังไม่ได้แก้ (ไว้ตัดสินใจรอบถัดไป):
-- SELECT viewname, definition FROM pg_views WHERE schemaname='public'
--   AND viewname IN ('v_letter_outcomes','v_promise_attribution_30d','v_partial_payment_progress');
