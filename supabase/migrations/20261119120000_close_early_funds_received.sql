-- 20261119120000: ปิดสัญญาก่อนกำหนดแบบ "เงินเข้าครบแล้ว" (ลูกค้าจ่ายก้อนปิดไปแล้วแต่ระบบยังเปิดอยู่) — แอดมินกดปิดอย่างเดียว ไม่ลงเงินซ้ำ
--
-- ============================================================================
-- บริบท (spec คุณเตยเคาะ 19 พ.ย. 2026):
--   ลูกค้าบางรายจ่ายปิดผ่านร้าน/PJ ไปแล้ว (เงินลงงวดท้ายบางส่วน ส่วนต่าง = ส่วนลดปิดก่อนกำหนด) แต่สัญญายังค้างสถานะ active
--   โหมดนี้ "ไม่เขียน payment_log / ไม่แก้ installments / ไม่แตะ pj_applied_ledger" — แค่ปิดสัญญา + เก็บค่าธรรมเนียม (ถ้ามี)
--   + บันทึก contract_close_events method='funds_received' เพื่อ undo ได้
--
-- กติกาคำนวณ (ต้องตรงกับ src/lib/earlyClose.ts analyzeEarlyClose, TOL = 1 บาท):
--   open(i)  = paid_at is null OR paid_amount < amount - 1
--   N = งวดสุดท้าย, s = installment_no ต่ำสุดที่ open (ไม่มี open => none)
--   D = max lastPayDate ของงวด no >= s ที่ paid_amount > 0 (ไม่มี => null)
--   lastPayDate = วันที่ (Asia/Bangkok) ของ payment_log action='pay' ล่าสุดที่ไม่ถูกยกเลิก (นับเฉพาะแถวหลัง 'cancel' ล่าสุดของงวด
--                 เหมือน penalty_paid_for_installment 0115); ไม่มี log => date(installments.paid_at, Asia/Bangkok)
--   T = ช่วงต่อเนื่อง [k..N]: เริ่ม [s..N] แล้วถอยหลัง s-1, s-2.. ตราบที่งวดนั้น paid_amount>0 AND lastPayDate = D
--   gross = Σamount(T), received = Σmin(paid_amount, amount)(T), shortfall = gross-received
--   mode: received=0 => collect
--         funds_in iff open = {N} AND 0<paid_N<amount_N-1 AND shortfall>1 AND shortfall/gross <= 0.30
--         else ambiguous        (T ที่เหลือจ่ายเต็มอยู่แล้วโดยปริยายเพราะ s = N)
--   penalty_due = Σ_T max(0, penalty_amount - penalty_paid_for_installment(id))   (open ⊆ T)
--
-- trade-off เรื่องหมายเหตุบังคับ: ส่วนลดจริงเทียบตารางส่วนลด (computeSettlement) คำนวณฝั่ง client เท่านั้น
--   RPC จึงรับ p_note_required boolean จาก client — ถ้า true แล้ว p_note ว่าง = error. ผู้เรียกที่ข้าม UI ได้ (admin เท่านั้น)
--   ส่ง false ได้เอง; ยอมรับได้เพราะ admin-only + บันทึกคนปิดใน contract_close_events
--
-- Additive only: add column if not exists + ฟังก์ชันใหม่ + create or replace undo (คงของเดิมทุกอย่าง เพิ่มกิ่ง funds_received)
-- ไม่มี CHECK constraint บน contract_close_events.method (ตรวจแล้วใน 0131) จึงใช้ค่า 'funds_received' ได้เลย
-- ============================================================================


-- ============================================================================
-- SECTION 1: คอลัมน์ใหม่บน contract_close_events
-- ============================================================================
alter table public.contract_close_events
  add column if not exists fee_waiver_id uuid null;   -- แถว fee_waivers ที่ event นี้สร้าง (null = ไม่ได้ยกเว้น หรือมีอยู่ก่อนแล้ว)
alter table public.contract_close_events
  add column if not exists note text null;


-- ============================================================================
-- SECTION 2: helper วิเคราะห์สัญญาเดียว (ภายใน — ไม่เปิดให้ authenticated เรียกตรง)
-- ============================================================================
create or replace function public.early_close_funds_in_analysis(p_contract_id uuid)
returns table (
  mode             text,       -- none | collect | funds_in | ambiguous
  closed_day       date,       -- D
  tail_ids         uuid[],     -- T
  tail_start_no    int,
  last_no          int,
  last_due_date    date,       -- due_date ของงวดสุดท้าย
  gross            numeric,
  received         numeric,
  shortfall        numeric,
  shortfall_pct    numeric,
  penalty_due      numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  c_tol constant numeric := 1;
  v_ids      uuid[];
  v_nos      int[];
  v_amt      numeric[];
  v_paid     numeric[];
  v_open     boolean[];
  v_last     date[];
  v_pen      numeric[];
  v_due      date[];
  v_cnt      int;
  v_s        int;
  v_d        date;
  v_k        int;
  v_i        int;
  v_gross    numeric := 0;
  v_recv     numeric := 0;
  v_pdue     numeric := 0;
  v_mode     text;
  v_date_missing boolean;
begin
  select array_agg(x.id order by x.installment_no),
         array_agg(x.installment_no order by x.installment_no),
         array_agg(x.amount order by x.installment_no),
         array_agg(x.paid order by x.installment_no),
         array_agg(x.is_open order by x.installment_no),
         array_agg(x.last_pay order by x.installment_no),
         array_agg(x.pen_due order by x.installment_no),
         array_agg(x.due_date order by x.installment_no)
    into v_ids, v_nos, v_amt, v_paid, v_open, v_last, v_pen, v_due
    from (
      select i.id, i.installment_no, i.amount, i.due_date,
             coalesce(i.paid_amount, 0) as paid,
             (i.paid_at is null or coalesce(i.paid_amount, 0) < i.amount - c_tol) as is_open,
             coalesce(
               (select max((pl.created_at at time zone 'Asia/Bangkok')::date)
                  from public.payment_log pl
                 where pl.installment_id = i.id
                   and pl.action = 'pay'
                   and pl.created_at > coalesce(
                         (select max(cc.created_at) from public.payment_log cc
                           where cc.installment_id = i.id and cc.action = 'cancel'),
                         '-infinity'::timestamptz)),
               (i.paid_at at time zone 'Asia/Bangkok')::date
             ) as last_pay,
             greatest(0, coalesce(i.penalty_amount, 0) - public.penalty_paid_for_installment(i.id)) as pen_due
        from public.installments i
       where i.contract_id = p_contract_id
    ) x;

  v_cnt := coalesce(array_length(v_ids, 1), 0);
  if v_cnt = 0 then
    return query select 'none'::text, null::date, '{}'::uuid[], null::int, null::int, null::date,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric;
    return;
  end if;

  -- s = ตำแหน่งแรกที่ open
  v_s := null;
  for v_i in 1..v_cnt loop
    if v_open[v_i] then v_s := v_i; exit; end if;
  end loop;

  if v_s is null then
    return query select 'none'::text, null::date, '{}'::uuid[], null::int, v_nos[v_cnt], v_due[v_cnt],
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric;
    return;
  end if;

  -- D = max lastPayDate ของงวด >= s ที่ paid>0
  v_d := null;
  for v_i in v_s..v_cnt loop
    if v_paid[v_i] > 0 and v_last[v_i] is not null and (v_d is null or v_last[v_i] > v_d) then
      v_d := v_last[v_i];
    end if;
  end loop;

  -- T = [k..N] ถอยหลังจาก s ตราบที่ paid>0 และ lastPayDate = D
  v_k := v_s;
  while v_d is not null and v_k > 1 and v_paid[v_k - 1] > 0 and v_last[v_k - 1] = v_d loop
    v_k := v_k - 1;
  end loop;

  for v_i in v_k..v_cnt loop
    v_gross := v_gross + v_amt[v_i];
    v_recv  := v_recv + least(v_paid[v_i], v_amt[v_i]);
    v_pdue  := v_pdue + v_pen[v_i];
  end loop;

  -- dateMissing (mirror TS): งวด >= s ที่มีเงิน (paid>0) แต่ไม่มี lastPayDate (ไม่มี pay log และ paid_at null) => ambiguous
  v_date_missing := false;
  for v_i in v_s..v_cnt loop
    if v_paid[v_i] > 0 and v_last[v_i] is null then v_date_missing := true; exit; end if;
  end loop;

  if v_recv = 0 then
    v_mode := 'collect';
  elsif v_date_missing then
    v_mode := 'ambiguous';
  elsif v_s = v_cnt
        and v_paid[v_cnt] > 0
        and v_paid[v_cnt] < v_amt[v_cnt] - c_tol
        and (v_gross - v_recv) <= c_tol then
    v_mode := 'none';   -- รูปทรง funds_in แต่ส่วนต่าง <= 1 บาท (mirror TS)
  elsif v_s = v_cnt
        and v_paid[v_cnt] > 0
        and v_paid[v_cnt] < v_amt[v_cnt] - c_tol
        and (v_gross - v_recv) / v_gross <= 0.30 then
    v_mode := 'funds_in';
  else
    v_mode := 'ambiguous';
  end if;

  return query select v_mode, v_d, v_ids[v_k:v_cnt], v_nos[v_k], v_nos[v_cnt], v_due[v_cnt],
                      v_gross, v_recv, v_gross - v_recv,
                      case when v_gross > 0 then (v_gross - v_recv) / v_gross else 0 end,
                      v_pdue;
end;
$$;

-- ภายในเท่านั้น: ถอนจากทุก role (RPC ที่เรียกเป็น security definer จึงยังใช้ได้)
revoke execute on function public.early_close_funds_in_analysis(uuid) from public, anon, authenticated;
grant execute on function public.early_close_funds_in_analysis(uuid) to service_role;

comment on function public.early_close_funds_in_analysis(uuid) is
  '(20261119120000) วิเคราะห์โหมดปิดก่อนกำหนด T/D/gross/received/shortfall/penalty_due ของสัญญาเดียว — mirror analyzeEarlyClose ฝั่ง client; ใช้ภายในโดย close_contract_early_funds_received + list_early_close_candidates';


-- ============================================================================
-- SECTION 3: RPC close_contract_early_funds_received — admin เท่านั้น
-- ============================================================================
create or replace function public.close_contract_early_funds_received(
  p_contract_id        uuid,
  p_closed_at          date,
  p_fees               jsonb   default '[]'::jsonb,   -- '[{"category":"ค่าดำเนินการ","amount":6000}]'
  p_waive              boolean default false,         -- ยกเว้นค่าธรรมเนียมปิดด่วน (fee_waivers fee_right='settle')
  p_note               text    default null,
  p_note_required      boolean default false          -- client บอกว่าส่วนลดไม่ตรงตาราง => ต้องมีหมายเหตุ
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_by_name          text;
  v_contract_status  text;
  a                  record;
  v_fee_item         jsonb;
  v_fee_amount       numeric;
  v_fee_category     text;
  v_fee_oi_id        uuid;
  v_other_income_ids uuid[] := '{}';
  v_waiver_id        uuid := null;
  v_event_id         uuid;
  v_today            date := (now() at time zone 'Asia/Bangkok')::date;
begin
  -- SECURITY GUARD: admin ที่ active เท่านั้น
  select coalesce(nullif(full_name, ''), '') into v_by_name
    from public.profiles
   where id = auth.uid() and role = 'admin' and active = true;

  if not found then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ปิดสัญญาแบบเงินเข้าครบแล้วได้';
  end if;

  if p_closed_at is null then
    raise exception 'ต้องระบุวันที่ปิดสัญญา';
  end if;
  if p_closed_at > v_today then
    raise exception 'วันที่ปิดสัญญาต้องไม่เกินวันนี้';
  end if;

  -- ล็อกสัญญาก่อน แล้วค่อยล็อกงวด (ลำดับเดียวกับทางลงเงิน 0185/0188)
  select status into v_contract_status
    from public.contracts
   where id = p_contract_id
   for update;

  if not found then
    raise exception 'ไม่พบสัญญานี้: %', p_contract_id;
  end if;
  if v_contract_status is distinct from 'active' then
    raise exception 'ปิดก่อนกำหนดได้เฉพาะสัญญาที่ยัง active เท่านั้น (สถานะปัจจุบัน: %)', v_contract_status;
  end if;

  perform 1 from public.installments where contract_id = p_contract_id for update;

  select * into a from public.early_close_funds_in_analysis(p_contract_id);

  if a.mode is distinct from 'funds_in' then
    raise exception 'สัญญานี้ไม่เข้าเงื่อนไข "เงินเข้าครบแล้ว" (โหมดที่ระบบตรวจได้: %) — ใช้การปิดแบบเก็บเงินตามปกติแทน', coalesce(a.mode, 'none');
  end if;

  if a.penalty_due > 0 then
    raise exception 'ยังมีค่าปรับค้าง % ฿ · เก็บค่าปรับก่อนจึงปิดแบบเงินเข้าครบแล้วได้', a.penalty_due;
  end if;

  if coalesce(p_waive, false) and jsonb_array_length(coalesce(p_fees, '[]'::jsonb)) > 0 then
    raise exception 'ยกเว้นค่าธรรมเนียมพร้อมกับเก็บค่าธรรมเนียมไม่ได้ · เลือกอย่างใดอย่างหนึ่ง';
  end if;

  -- p_note_required: เชื่อค่าจาก client (ส่วนลดตารางคำนวณฝั่ง client เท่านั้น) — ตั้งใจ: admin-only + บันทึกคนปิดใน event
  if coalesce(p_note_required, false) and (p_note is null or btrim(p_note) = '') then
    raise exception 'กรุณาระบุหมายเหตุที่ส่วนลดไม่ตรงตาราง';
  end if;

  -- ค่าธรรมเนียม: other_income fee_kind='settle' (เหมือน 0131)
  for v_fee_item in select * from jsonb_array_elements(coalesce(p_fees, '[]'::jsonb)) loop
    v_fee_amount   := coalesce((v_fee_item ->> 'amount')::numeric, 0);
    v_fee_category := v_fee_item ->> 'category';

    if v_fee_amount < 0 then
      raise exception 'ยอดค่าธรรมเนียมต้องไม่ติดลบ: %', v_fee_amount;
    end if;
    if v_fee_amount > 0 and (v_fee_category is null or btrim(v_fee_category) = '') then
      raise exception 'กรุณาระบุประเภทค่าธรรมเนียม';
    end if;

    if v_fee_amount > 0 then
      insert into public.other_income (
        contract_id, amount, category, note, received_at, recorded_by, fee_kind
      ) values (
        p_contract_id, v_fee_amount, v_fee_category, p_note, p_closed_at, v_by_name, 'settle'
      ) returning id into v_fee_oi_id;
      v_other_income_ids := array_append(v_other_income_ids, v_fee_oi_id);
    end if;
  end loop;

  -- ยกเว้นค่าธรรมเนียมปิดด่วน (ถ้ามีอยู่แล้ว = ไม่ทำซ้ำ และ undo จะไม่ลบของเดิม)
  if coalesce(p_waive, false) then
    insert into public.fee_waivers (contract_id, fee_right, waived_by, note)
    values (p_contract_id, 'settle', v_by_name,
            coalesce(nullif(btrim(p_note), ''), 'ปิดก่อนกำหนด (เงินเข้าครบแล้ว)'))
    on conflict do nothing
    returning id into v_waiver_id;
  end if;

  -- ปิดสัญญา — รูปแบบ close-day: remaining=gross, paid=received, discount=shortfall
  -- ⚠️ ไม่แตะ installments / payment_log / pj_applied_ledger
  update public.contracts
     set status               = 'closed',
         settled_at           = p_closed_at::timestamptz,
         settlement_remaining = a.gross,
         settlement_paid      = a.received,
         settlement_discount  = a.shortfall,
         settled_by           = v_by_name
   where id = p_contract_id;

  insert into public.contract_close_events (
    contract_id, method, payment_log_id, other_income_ids,
    settlement_paid, settlement_discount, settlement_remaining, penalty_received,
    closed_at, closed_by, fee_waiver_id, note
  ) values (
    p_contract_id, 'funds_received', null, v_other_income_ids,
    a.received, a.shortfall, a.gross, 0,
    p_closed_at, auth.uid(), v_waiver_id, nullif(btrim(coalesce(p_note, '')), '')
  ) returning id into v_event_id;

  return jsonb_build_object(
    'event_id',    v_event_id,
    'closed_at',   p_closed_at,
    'closed_day',  a.closed_day,
    'gross',       a.gross,
    'received',    a.received,
    'shortfall',   a.shortfall,
    'fee_count',   coalesce(array_length(v_other_income_ids, 1), 0),
    'waived',      v_waiver_id is not null
  );
end;
$$;

revoke execute on function public.close_contract_early_funds_received(uuid, date, jsonb, boolean, text, boolean) from public, anon;
grant execute on function public.close_contract_early_funds_received(uuid, date, jsonb, boolean, text, boolean)
  to authenticated, service_role;

comment on function public.close_contract_early_funds_received(uuid, date, jsonb, boolean, text, boolean) is
  '(20261119120000) ปิดสัญญาก่อนกำหนดแบบเงินเข้าครบแล้ว — admin active เท่านั้น; ต้องเป็นโหมด funds_in (คำนวณซ้ำฝั่ง DB) และไม่มีค่าปรับค้าง;
   ไม่เขียน payment_log/installments/pj_applied_ledger; เก็บ other_income fee_kind=settle + fee_waivers(settle) ตามที่ส่งมา;
   settlement_remaining=gross, settlement_paid=received, settlement_discount=shortfall; p_note_required=true ต้องมีหมายเหตุ';


-- ============================================================================
-- SECTION 4: undo_close_contract_early — เนื้อจาก 0131 (ไม่มีไฟล์ไหนแก้ต่อ; Cream ต้อง diff กับ prod md5 fcc89d74... ก่อน apply)
--   เพิ่ม: ลบ fee_waivers ที่ event สร้าง; แตะ pj_applied_ledger เฉพาะ method='preserve_schedule'
-- ============================================================================
create or replace function public.undo_close_contract_early(
  p_event_id uuid,
  p_reason   text
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_event contract_close_events%rowtype;
  v_contract_status text;
begin
  -- SECURITY GUARD: admin เท่านั้น
  if not is_admin() then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ยกเลิกการปิดสัญญาก่อนกำหนดได้';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ต้องระบุเหตุผลในการยกเลิก';
  end if;

  select * into v_event
    from public.contract_close_events
   where id = p_event_id
   for update;

  if not found then
    raise exception 'ไม่พบรายการปิดสัญญานี้: %', p_event_id;
  end if;

  -- idempotent guard: ยกเลิกซ้ำต้อง error ภาษาไทย ไม่ใช่พัง/ลบซ้ำ
  if v_event.undone_at is not null then
    raise exception 'รายการนี้ถูกยกเลิกไปแล้วเมื่อ %', v_event.undone_at;
  end if;

  select status into v_contract_status
    from public.contracts
   where id = v_event.contract_id
   for update;

  if v_contract_status is distinct from 'closed' then
    raise exception 'สถานะสัญญาปัจจุบันไม่ใช่ "ปิดแล้ว" (เป็น %) — ยกเลิกทางนี้ไม่ได้ กรุณาตรวจสอบก่อน', v_contract_status;
  end if;

  -- 1) ลบ payment_log ของงวดที่ผูกไว้ (funds_received ไม่มี = null ข้าม)
  if v_event.payment_log_id is not null then
    delete from public.payment_log where id = v_event.payment_log_id;
  end if;

  -- 2) ลบ other_income ทุกแถวที่ event นี้สร้างไว้
  if v_event.other_income_ids is not null and array_length(v_event.other_income_ids, 1) > 0 then
    delete from public.other_income where id = any(v_event.other_income_ids);
  end if;

  -- 2b) ลบ fee_waivers ที่ event นี้สร้าง (funds_received เท่านั้นที่เติมค่านี้)
  if v_event.fee_waiver_id is not null then
    delete from public.fee_waivers where id = v_event.fee_waiver_id;
  end if;

  -- 3) ลบ ledger กันซ้ำ PJ เฉพาะ event แบบ preserve_schedule (funds_received ไม่เคยเขียน ledger
  --    จึงห้ามไปลบ ledger ของ auto-sync ที่บังเอิญวันเดียวกัน)
  if v_event.method = 'preserve_schedule' then
    delete from public.pj_applied_ledger
     where contract_id = v_event.contract_id
       and pj_paid_date = v_event.closed_at
       and source = 'settle';
  end if;

  -- 4) คืนสัญญาเป็น active + เคลียร์คอลัมน์ settlement_*
  update public.contracts
     set status               = 'active',
         settled_at           = null,
         settlement_discount  = null,
         settlement_remaining = null,
         settlement_paid      = null,
         settled_by           = null
   where id = v_event.contract_id;

  -- 5) mark event ว่าถูกยกเลิกแล้ว
  update public.contract_close_events
     set undone_at   = now(),
         undone_by   = auth.uid(),
         undo_reason = p_reason
   where id = p_event_id;
end;
$$;

revoke execute on function public.undo_close_contract_early(uuid, text) from public, anon;
grant execute on function public.undo_close_contract_early(uuid, text) to authenticated, service_role;


-- ============================================================================
-- Verify (Cream รันหลัง apply; dry-run ด้วย begin/rollback — ต้องรันด้วย JWT admin จริง เพราะเช็ค auth.uid())
-- ============================================================================
-- a) สิทธิ์ (expected: false / false / true / true):
-- select has_function_privilege('anon', 'public.close_contract_early_funds_received(uuid, date, jsonb, boolean, text, boolean)', 'EXECUTE'),
--        has_function_privilege('anon', 'public.undo_close_contract_early(uuid, text)', 'EXECUTE'),
--        has_function_privilege('authenticated', 'public.close_contract_early_funds_received(uuid, date, jsonb, boolean, text, boolean)', 'EXECUTE'),
--        has_function_privilege('authenticated', 'public.undo_close_contract_early(uuid, text)', 'EXECUTE');
-- b) helper ปิดจาก authenticated (expected: false):
-- select has_function_privilege('authenticated', 'public.early_close_funds_in_analysis(uuid)', 'EXECUTE');
-- c) เทียบ trace spec (P-JA020094 ควรได้ funds_in, gross 8376, received 7790, shortfall 586, D 2026-09-23 — ปิดไปแล้วจะเป็น none):
-- select * from public.early_close_funds_in_analysis((select id from public.contracts where contract_no = 'S00003PNQ126'));
-- d) dry-run ปิด (เปลี่ยน <id> เป็นสัญญา funds_in ที่ active):
--   begin;
--     select public.close_contract_early_funds_received('<id>'::uuid, current_date,
--       '[{"category":"ค่าดำเนินการ","amount":200}]'::jsonb, false, 'ทดสอบ', false);
--     -- expected: jsonb event_id/gross/received/shortfall
--     select status, settled_at, settlement_remaining, settlement_paid, settlement_discount from public.contracts where id='<id>'::uuid;
--     select method, payment_log_id, other_income_ids, fee_waiver_id from public.contract_close_events where contract_id='<id>'::uuid and undone_at is null;
--     -- expected: funds_received / null / 1 id / null ; installments + payment_log ไม่เปลี่ยน
--     select public.undo_close_contract_early((select id from public.contract_close_events where contract_id='<id>'::uuid and undone_at is null), 'ทดสอบ');
--     select status from public.contracts where id='<id>'::uuid;  -- expected: active
--   rollback;
-- e) guard: สัญญา collect/ambiguous => ERROR 'ไม่เข้าเงื่อนไข ...'; p_note_required=true + note ว่าง => ERROR 'กรุณาระบุหมายเหตุ...';
--    staff JWT => ERROR 'เฉพาะแอดมินเท่านั้น...'; มีค่าปรับค้าง => ERROR 'ยังมีค่าปรับค้าง ...'
-- f) undo ของ event แบบ preserve_schedule เดิมยังทำงาน (ledger ถูกลบ) — ทดสอบด้วย begin/rollback
