-- 0183: ปุ่ม "ลงตาม PJ" ในกล่องรอตรวจลงเงินแบบ atomic + กันเงินเบิ้ล (หน้าเปิดค้าง / กดพร้อมกัน 2 คน)
-- เพิ่ม RPC apply_pj_review_payment: ล็อกแถวรอตรวจ -> ต้อง pending -> ใบเสร็จยังไม่เคยลง -> ลงเงิน -> ปิดแถว ใน transaction เดียว
-- Additive ทั้งไฟล์ (create or replace) ไม่แตะ record_payment_spread / pj-sync
--
-- ปัญหาเดิม: applyPjReviewPayment (db.ts) ไม่เช็คสถานะแถว และ record_payment_spread ใช้ on conflict do nothing
-- กับ pj_applied_receipts (ไม่กันเงิน) -> แถวที่ cron ลงแล้ว (auto_resolved) หรือคนอื่นกดไปแล้ว ยังกดลงซ้ำได้ = เงินเบิ้ล
--
-- ลำดับล็อก: pj_sync_review (for update) -> pj_applied_receipts (claim insert) -> installments/payment_log (ใน record_payment_spread)
--   cron pj-sync เรียก record_payment_spread คนละ transaction กับ update แถวรีวิว (update แยก statement ทีหลัง) จึงไม่เกิดวงล็อกวน
--   update auto_resolved ของ cron ถ้าชนจะรอแล้วเห็นว่าไม่ใช่ pending แล้ว (READ COMMITTED recheck) -> ข้ามเอง
--
-- ความเสี่ยงที่เหลือ (ยอมรับ): cron ลงใบเดียวกันพร้อมกันพอดีระดับมิลลิวินาที (cron ตรวจ uuid ก่อนลง แล้วลงใน tx ถัดไป
--   และ record_payment_spread ของ cron ใช้ on conflict do nothing) ฝั่ง RPC นี้ claim uuid ก่อนลงเงินและ rollback ทั้งก้อน
--   ถ้า claim ไม่ครบ จึงกันได้ทุกกรณีที่ cron commit มาก่อน แต่กันฝั่ง cron ที่ commit ทีหลังไม่ได้ (ต้องแก้ record_payment_spread ซึ่งอยู่นอกขอบเขต)
--
-- ข้อความ error มี tag [PJR:...] นำหน้าให้หน้าเว็บแปลงเป็นข้อความไทยที่เข้าใจง่าย (src/lib/pjReviewApplyError.ts)

-- helper: parse ยอดจาก raw_json แบบไม่ระเบิด (เทียบเท่า parsePjAmount ฝั่งเว็บ: ตัดคอมมา, parse ไม่ได้ = 0)
-- ใช้เฉพาะภายใน (เรียกจากฟังก์ชัน security definer ด้านล่าง) จึง revoke จากทุก role
create or replace function public.pj_parse_amount_safe(p_text text)
returns numeric
language sql
immutable
set search_path = public, pg_catalog
as $$
  select case
    when replace(coalesce(p_text, ''), ',', '') ~ '^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]{1,3})?\s*$'
      then trim(replace(p_text, ',', ''))::numeric
    else 0::numeric
  end;
$$;

revoke all on function public.pj_parse_amount_safe(text) from public, anon, authenticated;

create or replace function public.apply_pj_review_payment(
  p_review_id uuid,
  p_principal numeric,
  p_penalty   numeric,
  p_paid_date date,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_by_name     text;
  v_rev         public.pj_sync_review%rowtype;
  v_receipts    jsonb := '[]'::jsonb;
  v_uuids       text[] := '{}';
  v_n           int := 0;
  v_claimed     int := 0;
  v_conflicting text[];
  v_exp_prin    numeric;
  v_exp_pen     numeric;
  v_pen_sum     numeric := 0;
  v_paid_date   date;
  v_src         jsonb;
begin
  -- สิทธิ์: เหมือน RLS ของกล่องรอตรวจ (0087) = admin หรือ staff ที่ active
  if auth.uid() is null or not (public.is_admin() or public.is_staff()) then
    raise exception '[PJR:FORBIDDEN] ไม่มีสิทธิ์ลงยอดจากกล่องรอตรวจ (ต้องเป็น admin หรือ staff ที่ยัง active)';
  end if;

  select coalesce(nullif(p.full_name, ''), u.email, 'ไม่ทราบ') into v_by_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = auth.uid();

  -- ล็อกแถว: คนที่สองจะรอจนคนแรก commit แล้วเห็น status ใหม่
  select * into v_rev from public.pj_sync_review where id = p_review_id for update;
  if not found then
    raise exception '[PJR:NOT_FOUND] ไม่พบรายการรอตรวจนี้';
  end if;
  if v_rev.status <> 'pending' then
    raise exception '[PJR:NOT_PENDING] รายการนี้ไม่ได้รอตรวจแล้ว (สถานะ: %)', v_rev.status;
  end if;

  -- reason ที่ห้ามลงเงินจากกล่องนี้ (คงตาม db.ts เดิม + CONTRACT_CLOSED ที่หน้าเว็บซ่อนปุ่มอยู่)
  if v_rev.reason in ('RECEIPT_MISSING', 'RECEIPT_CHANGED',
                      'RETURNED_CONTRACT_PAYMENT', 'RETURNED_CONTRACT_OVERAGE', 'RETURNED_CONTRACT_OTHER_FEE',
                      'CONTRACT_CLOSED') then
    raise exception '[PJR:MANUAL_ONLY] รายการประเภทนี้ (%) ห้ามลงยอดจากกล่องรอตรวจ ต้องตรวจและจัดการมือ', v_rev.reason;
  end if;
  if v_rev.matched_contract_id is null then
    raise exception '[PJR:NO_CONTRACT] รายการนี้ยังไม่ผูกกับสัญญา ลงยอดไม่ได้';
  end if;

  -- วันที่: ยึดวันจาก PJ ถ้ามี
  if v_rev.pj_paid_date is not null then
    if p_paid_date is distinct from v_rev.pj_paid_date then
      raise exception '[PJR:MISMATCH] วันที่ที่ส่งมาไม่ตรงกับรายการ (รายการ=%, ส่งมา=%)', v_rev.pj_paid_date, p_paid_date;
    end if;
    v_paid_date := v_rev.pj_paid_date;
  else
    if p_paid_date is null then
      raise exception '[PJR:MISMATCH] รายการไม่มีวันที่จ่าย ต้องระบุวันที่';
    end if;
    v_paid_date := p_paid_date;
  end if;

  -- ใบเสร็จที่ยังไม่เคยลง จาก raw_json (shape เดียวกับ extractPjPendingReceipts ฝั่งเว็บ):
  --   array ตรงๆ / object RECEIPT_PARTIAL_APPLIED (unapplied_receipts) / อย่างอื่น (returned_watch ฯลฯ) = ไม่มีใบ
  v_src := case
    when v_rev.raw_json is null then '[]'::jsonb
    when jsonb_typeof(v_rev.raw_json) = 'array' then v_rev.raw_json
    when jsonb_typeof(v_rev.raw_json) = 'object'
         and not (v_rev.raw_json ? 'kind')
         and jsonb_typeof(v_rev.raw_json -> 'unapplied_receipts') = 'array'
      then v_rev.raw_json -> 'unapplied_receipts'
    else '[]'::jsonb
  end;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'uuid', t.uuid, 'amount', t.amount, 'payment_type', t.ptype
    ) order by t.ord), '[]'::jsonb),
    coalesce(array_agg(t.uuid order by t.ord), '{}'::text[]),
    coalesce(sum(t.amount) filter (where t.ptype = 'penalty'), 0)
  into v_receipts, v_uuids, v_pen_sum
  from (
    select distinct on (x.uuid) x.uuid, x.amount, x.ptype, x.ord
      from (
        select
          nullif(trim(e.elem ->> 'uuid'), '') as uuid,
          public.pj_parse_amount_safe(e.elem ->> 'amount') as amount,
          coalesce(e.elem ->> 'payment_type', e.elem ->> 'paymentType') as ptype,
          e.ord
        from jsonb_array_elements(v_src) with ordinality as e(elem, ord)
      ) x
     where x.uuid is not null
     order by x.uuid, x.ord
  ) t;

  v_n := coalesce(array_length(v_uuids, 1), 0);

  -- ยอด: ต้องตรงกับที่แถวบอก (สูตรเดียวกับ ApplyPjModal) ไม่ให้ client ส่งยอดอื่นมาได้
  if v_rev.pj_payment_type = 'penalty' then
    v_exp_prin := 0;
    v_exp_pen  := coalesce(v_rev.pj_amount, 0);
  else
    v_exp_prin := coalesce(v_rev.pj_amount, 0);
    v_exp_pen  := v_pen_sum;
  end if;
  if abs(coalesce(p_principal, 0) - v_exp_prin) > 0.005 or abs(coalesce(p_penalty, 0) - v_exp_pen) > 0.005 then
    raise exception '[PJR:MISMATCH] ยอดที่ส่งมาไม่ตรงกับรายการ (รายการ: ต้น % / ปรับ %, ส่งมา: ต้น % / ปรับ %)',
      v_exp_prin, v_exp_pen, coalesce(p_principal, 0), coalesce(p_penalty, 0);
  end if;

  -- ใบเสร็จที่ลงไปแล้ว (cron / กล่องอื่น / ผูกมือ) ห้ามลงทับ
  if v_n > 0 then
    select array_agg(pj_receipt_uuid) into v_conflicting
      from public.pj_applied_receipts
     where pj_receipt_uuid = any(v_uuids);
    if v_conflicting is not null then
      raise exception '[PJR:RECEIPT_APPLIED] ใบเสร็จถูกลงไปแล้ว (% ใบ)', array_length(v_conflicting, 1);
    end if;

    -- claim uuid ก่อนลงเงิน (ถ้า cron แทรก commit มาก่อน insert จะไม่ครบ -> rollback ทั้งก้อน)
    insert into public.pj_applied_receipts (
      pj_receipt_uuid, contract_id, pj_invoice_no, pj_paid_date, amount, payment_type, source
    )
    select
      e ->> 'uuid', v_rev.matched_contract_id, v_rev.pj_invoice_no, v_paid_date,
      coalesce((e ->> 'amount')::numeric, 0),
      coalesce(e ->> 'payment_type', v_rev.pj_payment_type),
      'review'
    from jsonb_array_elements(v_receipts) as e
    on conflict (pj_receipt_uuid) do nothing;
    get diagnostics v_claimed = row_count;
    if v_claimed <> v_n then
      raise exception '[PJR:RECEIPT_APPLIED] ใบเสร็จถูกลงไปแล้วโดยรายการอื่นพร้อมกัน';
    end if;
  end if;

  -- ลงเงิน (p_receipt_uuids = null เพราะ claim ไปแล้วข้างบน)
  perform public.record_payment_spread(
    v_rev.matched_contract_id,
    coalesce(p_principal, 0),
    coalesce(p_penalty, 0),
    v_paid_date::timestamp at time zone 'UTC',
    v_by_name,
    null
  );

  -- ledger กันลงซ้ำของ auto-sync (เดิมเขียนจากเว็บแยก tx)
  insert into public.pj_applied_ledger (contract_id, pj_paid_date, inst_amount, pen_amount, source, applied_at)
  values (v_rev.matched_contract_id, v_paid_date, coalesce(p_principal, 0), coalesce(p_penalty, 0), 'review', now())
  on conflict (contract_id, pj_paid_date) do update
    set inst_amount = excluded.inst_amount,
        pen_amount  = excluded.pen_amount,
        source      = excluded.source,
        applied_at  = excluded.applied_at;

  update public.pj_sync_review
     set status          = 'resolved',
         resolved_by     = v_by_name,
         resolved_at     = now(),
         resolution_note = coalesce(nullif(trim(p_note), ''), 'ลงยอดจากกล่องรอตรวจ')
   where id = p_review_id;

  return jsonb_build_object(
    'contract_id', v_rev.matched_contract_id,
    'reason', v_rev.reason,
    'pj_payment_type', v_rev.pj_payment_type,
    'receipt_count', v_n
  );
end;
$$;

revoke all on function public.apply_pj_review_payment(uuid, numeric, numeric, date, text) from public, anon;
grant execute on function public.apply_pj_review_payment(uuid, numeric, numeric, date, text) to authenticated;

comment on function public.apply_pj_review_payment(uuid, numeric, numeric, date, text) is
  '(0183) ลงเงินจากปุ่ม "ลงตาม PJ" ในกล่องรอตรวจแบบ atomic: ล็อกแถว pending + เช็คใบเสร็จยังไม่ลง + claim uuid + record_payment_spread + ledger + ปิดแถว resolved ใน tx เดียว; admin/staff active เท่านั้น; ห้าม reason RECEIPT_MISSING/CHANGED/RETURNED_*/CONTRACT_CLOSED; ยอด/วันที่ต้องตรงกับแถว; ส่วนปรับค่าปรับตาม PJ (pj_review_set_penalty) ยังทำฝั่งเว็บหลังเรียกนี้';

-- ============================================================================
-- รายได้อื่นๆ จากกล่องรอตรวจ: ล็อกแถว pending + insert other_income + ปิดแถว ใน tx เดียว
-- เดิมเว็บ insert แล้ว resolve แยกกัน (ภายหลังเปลี่ยนเป็นจองแถวก่อน -> แท็บปิดกลางทางแล้วเงินหายเงียบ)
-- กฎเดิมที่คงไว้: staff+admin ทำได้ (RLS 0054), amount>=0 ตาม table check (RPC บังคับ >0 เหมือนปุ่มหน้าเว็บ), ยอดกรอกเองได้
-- (ไม่ผูกกับ pj_amount เพราะหน้าให้แก้ยอดได้), วันที่ผูกกับ pj_paid_date ของแถวถ้ามี, recorded_by = ชื่อผู้ล็อกอิน,
-- fee_kind ตรวจโดย check constraint ของตาราง (due_day/months/both/settle/transfer)
-- ผลต่อการนับ: ไม่แตะ installments/payment_log/pj_applied_ledger/pj_applied_receipts (ตรงกับเว็บเดิม) ไม่ปน collected/NPL
-- ============================================================================
create or replace function public.apply_pj_review_other_income(
  p_review_id   uuid,
  p_amount      numeric,
  p_category    text,
  p_received_at date,
  p_note        text default null,
  p_fee_kind    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_by_name text;
  v_rev     public.pj_sync_review%rowtype;
  v_date    date;
  v_cat     text := trim(coalesce(p_category, ''));
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_id      uuid;
begin
  if auth.uid() is null or not (public.is_admin() or public.is_staff()) then
    raise exception '[PJR:FORBIDDEN] ไม่มีสิทธิ์บันทึกรายได้อื่นๆ จากกล่องรอตรวจ';
  end if;

  select coalesce(nullif(p.full_name, ''), u.email, 'ไม่ทราบ') into v_by_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = auth.uid();

  select * into v_rev from public.pj_sync_review where id = p_review_id for update;
  if not found then
    raise exception '[PJR:NOT_FOUND] ไม่พบรายการรอตรวจนี้';
  end if;
  if v_rev.status <> 'pending' then
    raise exception '[PJR:NOT_PENDING] รายการนี้ไม่ได้รอตรวจแล้ว (สถานะ: %)', v_rev.status;
  end if;
  if v_rev.reason in ('RECEIPT_MISSING', 'RECEIPT_CHANGED',
                      'RETURNED_CONTRACT_PAYMENT', 'RETURNED_CONTRACT_OVERAGE', 'RETURNED_CONTRACT_OTHER_FEE',
                      'CONTRACT_CLOSED') then
    raise exception '[PJR:MANUAL_ONLY] รายการประเภทนี้ (%) ห้ามลงเป็นรายได้อื่นๆ จากกล่องรอตรวจ ต้องตรวจและจัดการมือ', v_rev.reason;
  end if;
  if v_rev.matched_contract_id is null then
    raise exception '[PJR:NO_CONTRACT] รายการนี้ยังไม่ผูกกับสัญญา ลงยอดไม่ได้';
  end if;

  if coalesce(p_amount, 0) <= 0 or v_cat = '' then
    raise exception '[PJR:MISMATCH] ต้องระบุยอดมากกว่า 0 และหมวดรายได้';
  end if;

  if v_rev.pj_paid_date is not null then
    if p_received_at is distinct from v_rev.pj_paid_date then
      raise exception '[PJR:MISMATCH] วันที่ที่ส่งมาไม่ตรงกับรายการ (รายการ=%, ส่งมา=%)', v_rev.pj_paid_date, p_received_at;
    end if;
    v_date := v_rev.pj_paid_date;
  else
    if p_received_at is null then
      raise exception '[PJR:MISMATCH] รายการไม่มีวันที่จ่าย ต้องระบุวันที่';
    end if;
    v_date := p_received_at;
  end if;

  insert into public.other_income (contract_id, amount, category, note, received_at, recorded_by, fee_kind)
  values (v_rev.matched_contract_id, p_amount, v_cat, v_note, v_date, v_by_name, nullif(trim(coalesce(p_fee_kind, '')), ''))
  returning id into v_id;

  update public.pj_sync_review
     set status          = 'resolved',
         resolved_by     = v_by_name,
         resolved_at     = now(),
         resolution_note = case when v_note is not null
                                then 'ลงเป็นรายได้อื่นๆ (' || v_cat || '): ' || v_note
                                else 'ลงเป็นรายได้อื่นๆ (' || v_cat || ')' end
   where id = p_review_id;

  return jsonb_build_object('other_income_id', v_id, 'contract_id', v_rev.matched_contract_id);
end;
$$;

revoke all on function public.apply_pj_review_other_income(uuid, numeric, text, date, text, text) from public, anon;
grant execute on function public.apply_pj_review_other_income(uuid, numeric, text, date, text, text) to authenticated;

comment on function public.apply_pj_review_other_income(uuid, numeric, text, date, text, text) is
  '(0183) บันทึกรายได้อื่นๆ จากกล่องรอตรวจ atomic: ล็อกแถว pending + insert other_income + ปิดแถว resolved ใน tx เดียว; admin/staff active; ห้าม reason drift/RETURNED_*/CONTRACT_CLOSED; วันที่ผูกกับ pj_paid_date; ยอดกรอกเองได้ (>0)';

-- Verify หลัง apply:
--   select has_function_privilege('authenticated', 'public.apply_pj_review_payment(uuid,numeric,numeric,date,text)', 'EXECUTE'); -- true
--   select has_function_privilege('anon', 'public.apply_pj_review_payment(uuid,numeric,numeric,date,text)', 'EXECUTE');          -- false
--   select has_function_privilege('authenticated', 'public.apply_pj_review_other_income(uuid,numeric,text,date,text,text)', 'EXECUTE'); -- true
--   select has_function_privilege('anon', 'public.apply_pj_review_other_income(uuid,numeric,text,date,text,text)', 'EXECUTE');          -- false
--   select has_function_privilege('authenticated', 'public.pj_parse_amount_safe(text)', 'EXECUTE');                                       -- false
