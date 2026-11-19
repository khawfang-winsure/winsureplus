-- 20261119120100: รายการสัญญาที่ "เงินเข้าครบแล้ว รอแอดมินกดปิด" (list_early_close_candidates) — แอดมินเท่านั้น อ่านอย่างเดียว
--
-- คืนเฉพาะสัญญา active ที่ early_close_funds_in_analysis ให้โหมด funds_in (ไม่กรองค่าปรับค้าง/กล่องรอตรวจ PJ ออก —
-- ส่งเป็นคอลัมน์ให้ UI ตัดสินใจ) ผลลัพธ์มีแค่เคสผู้สมัคร จึงไม่ชนเพดาน 1,000 แถวของ REST
-- Prefilter: งวดสุดท้ายต้องจ่ายบางส่วน (0 < paid < amount-1) ก่อนค่อยเรียก helper (ลดงานต่อสัญญาทั้งฐาน)
-- has_pending_pj_review = มีแถว pj_sync_review ของสัญญานี้ที่ status='pending' (resolved/skipped = จบแล้ว)
-- Additive: ฟังก์ชันใหม่ ไม่แตะข้อมูล (ต้อง apply หลัง 20261119120000 เพราะเรียก helper ในไฟล์นั้น)

create or replace function public.list_early_close_candidates()
returns table (
  contract_id           uuid,
  contract_no           text,
  customer_name         text,
  shop_name             text,
  closed_day            date,      -- D = วันที่เงินเข้าล่าสุด
  days_since_d          int,
  last_due_date         date,      -- วันครบกำหนดงวดสุดท้าย
  gross                 numeric,
  received              numeric,
  shortfall             numeric,
  shortfall_pct         numeric,
  penalty_due           numeric,
  has_pending_pj_review boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid() and role = 'admin' and active = true
  ) then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ดูรายการรอกดปิดได้';
  end if;

  return query
  select c.id, c.contract_no, c.customer_name, s.name,
         a.closed_day,
         ((now() at time zone 'Asia/Bangkok')::date - a.closed_day)::int,
         a.last_due_date, a.gross, a.received, a.shortfall, a.shortfall_pct, a.penalty_due,
         exists (select 1 from public.pj_sync_review r
                  where r.matched_contract_id = c.id and r.status = 'pending')
    from public.contracts c
    left join public.shops s on s.id = c.shop_id
    cross join lateral public.early_close_funds_in_analysis(c.id) a
   where c.status = 'active'
     and exists (
       select 1 from public.installments li
        where li.contract_id = c.id
          and li.installment_no = (select max(x.installment_no) from public.installments x where x.contract_id = c.id)
          and coalesce(li.paid_amount, 0) > 0
          and coalesce(li.paid_amount, 0) < li.amount - 1)
     and a.mode = 'funds_in'
   order by a.closed_day asc nulls last, c.contract_no;
end;
$$;

revoke execute on function public.list_early_close_candidates() from public, anon;
grant execute on function public.list_early_close_candidates() to authenticated, service_role;

comment on function public.list_early_close_candidates() is
  '(20261119120100) สัญญา active โหมด funds_in (เงินเข้าครบแล้วรอกดปิด) — admin active เท่านั้น; มีคอลัมน์ penalty_due / has_pending_pj_review ให้ UI เตือน ไม่กรองทิ้ง';

-- Verify (JWT admin): select * from public.list_early_close_candidates();
--   expected รวม S00003PNQ126 (gross 5344 / received 4970 / shortfall 374 / D 2026-11-12) ถ้ายัง active
--   staff JWT => ERROR 'เฉพาะแอดมินเท่านั้น...'; has_function_privilege('anon','public.list_early_close_candidates()','EXECUTE') = false
