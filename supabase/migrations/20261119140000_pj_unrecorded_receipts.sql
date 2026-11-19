-- 20261119140000: ตัวตรวจใบเสร็จ PJ ตกหล่น (RECEIPT_UNRECORDED) — เปิดทางให้กล่องรอตรวจรับเคส "ใบ PJ ที่ไม่เคยถูกลงเป็นค่างวด/ค่าปรับ"
-- และให้ปุ่มผูก/ลงตาม PJ ใช้กับเคสนี้ได้ (Wave 1 = schema + RPC เท่านั้น; ตัวตรวจอยู่ pj-sync Wave 2)
--
-- สิ่งที่ตรวจแล้วก่อนเขียน (อ่านจาก migration ทั้งหมดใน repo):
--   - pj_sync_review.reason เป็น text not null ไม่มี CHECK/enum (0077 + ยืนยันใน 0158 หัวข้อ h) -> ไม่ต้องแก้ constraint
--     (ครีมเช็คของจริงอีกครั้ง: select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.pj_sync_review'::regclass)
--   - pj_sync_review.pj_receipt_uuid มีอยู่แล้ว (0114, เดิมใช้ drift RECEIPT_MISSING/CHANGED + unique index pj_sync_review_drift_uuid_uidx
--     เฉพาะ 2 reason นั้น) -> ไม่เพิ่มคอลัมน์ ใช้ซ้ำ + เพิ่ม unique index แยกสำหรับ RECEIPT_UNRECORDED
--   - apply_pj_review_payment (0183) กรองแค่ denylist (MISSING/CHANGED/RETURNED_*/CONTRACT_CLOSED) -> RECEIPT_UNRECORDED ผ่านอยู่แล้ว
--     ไม่ต้องแก้ ถ้าแถวตั้ง pj_payment_type + pj_amount ถูก (ดูหมายเหตุสัญญากับ detector ด้านล่าง)
--   - link_pj_review_to_payment_log: ตัวจริงบน prod เป็นเวอร์ชันย่อของ 0162 (ครีมเก็บ pg_get_functiondef 19 พ.ย.) -> ใช้ตัวจริงเป็นฐาน แก้ guard reason ตัวเดียว
--   - apply_pj_review_other_income (0183): เติมกันไม่ให้ปิดแถว UNRECORDED ที่เป็นค่างวด/ค่าปรับเป็น "รายได้อื่นๆ" (ต้นเหตุเดิมที่ทำใบหายเงียบ)
--
-- สัญญากับ detector (pj-sync mode unrecorded_watch) — 1 แถวต่อ 1 finding (grouped ต่อ สัญญา+วันจ่าย ตามสเปกแบม):
--   reason='RECEIPT_UNRECORDED' หรือ 'STAFF_MANUAL_OVERLAP', status='pending', matched_contract_id ไม่ null, pj_invoice_no, pj_paid_date ไม่ null,
--   pj_payment_type = 'installment' | 'penalty' | 'other', pj_amount = ต้น(ค่างวด) ของกลุ่ม (penalty ล้วน = ยอดค่าปรับ),
--   raw_json = array ใบดิบ PJ ของกลุ่ม (+ payment_type เป็นโค้ดอังกฤษ) — เฉพาะใบที่ยังไม่ถูกลง/ไม่อยู่ในแถวอื่น,
--   pj_receipt_uuid = uuid ต่ำสุดของกลุ่ม (idempotency key), detector_batch = 'backfill-2026-11' | 'daily',
--   overlap_detail = {kind:'unrecorded_watch', confidence, contractNote, applyBlocked, explainTh, receiptTotal, candidates:[{logId,byName,amount,penaltyPaidAmount,bangkokPaidDate,dayDiff,capacityLeft,matchKind}]} (camelCase ตามที่ UI อ่าน)
--   insert ... on conflict (pj_receipt_uuid) where reason in ('RECEIPT_UNRECORDED','STAFF_MANUAL_OVERLAP') and detector_batch is not null do nothing
--   (แถว STAFF_MANUAL_OVERLAP เดิมของ sync ปกติมี pj_receipt_uuid และ detector_batch เป็น null -> ไม่เข้า index นี้)
--   apply_pj_review_payment ใช้กับแถวกลุ่มได้: ต้น = pj_amount, ค่าปรับ = Σ ใบ penalty ใน raw_json ตามสูตร 0183
--
-- Additive/idempotent ทั้งไฟล์. ไม่ drop อะไร (ยกเว้น drop index if exists ของ index ใหม่ตัวเอง).

-- ============================================================================
-- SECTION 1: คอลัมน์ + index
-- ============================================================================
alter table public.pj_sync_review
  add column if not exists detector_batch text;

comment on column public.pj_sync_review.detector_batch is
  '(20261119140000) ล็อตที่ตัวตรวจ RECEIPT_UNRECORDED สร้างแถว เช่น backfill-2026-11 / daily — null = แถวปกติจาก flow อื่น ใช้แยกกล่อง backfill ให้ทีมเคลียร์เป็นก้อน';

-- กันแจ้งซ้ำถาวร: 1 finding (uuid ต่ำสุดของกลุ่ม) = 1 แถวตลอดกาล แม้ resolved/skipped แล้ว — รันซ้ำ/backfill ซ้ำ idempotent
-- (ครีมเช็คก่อน apply ว่าไม่มี pj_receipt_uuid ซ้ำใน reason เหล่านี้ที่ detector_batch ไม่ null — ตอนนี้ยังไม่มีแถวแบบนี้เลย)
-- ไม่ชนกับ pj_sync_review_drift_uuid_uidx (0114) เพราะ predicate คนละ reason
create unique index if not exists pj_sync_review_unrecorded_uuid_uidx
  on public.pj_sync_review (pj_receipt_uuid)
  where reason in ('RECEIPT_UNRECORDED', 'STAFF_MANUAL_OVERLAP') and detector_batch is not null;

create index if not exists pj_sync_review_detector_batch_idx
  on public.pj_sync_review (detector_batch)
  where detector_batch is not null;

-- ============================================================================
-- SECTION 2: link_pj_review_to_payment_log — รับ reason RECEIPT_UNRECORDED เพิ่มจาก STAFF_MANUAL_OVERLAP
-- ⚠️ ฐานคือ "ตัวจริงบน prod" (pg_get_functiondef ที่ครีมเก็บ 19 พ.ย. 2026 — เวอร์ชันย่อของ 0162) ไม่ใช่ข้อความ 0162 ใน repo
-- เปลี่ยนเฉพาะ guard reason (บรรทัดเดียว) ที่เหลือเหมือนเดิมทุกตัวอักษร: สิทธิ์ admin/staff active, status pending,
-- matched_contract_id, raw_json array, uuid ชนใน pj_applied_receipts, payment_log ต้อง pay/amount>0/acted_by/ไม่ถูก cancel/สัญญาตรง,
-- capacity_left, insert pj_applied_receipts source='staff-link', merge overlap_detail.link
-- ============================================================================
CREATE OR REPLACE FUNCTION public.link_pj_review_to_payment_log(p_review_id uuid, p_payment_log_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_role text; v_active boolean; v_by_name text;
  v_review public.pj_sync_review%rowtype; v_log public.payment_log%rowtype;
  v_receipts jsonb := '[]'::jsonb; v_receipt record; v_total_amount numeric := 0;
  v_uuids text[] := '{}'; v_conflicting text[]; v_capacity_left numeric;
  v_linked_json jsonb := '[]'::jsonb; v_inserted int := 0;
begin
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    raise exception 'ไม่มีสิทธิ์ผูกรายการนี้ (ต้องเป็น admin หรือ staff ที่ยัง active)';
  end if;
  select coalesce(nullif(p.full_name, ''), u.email, '') into v_by_name from auth.users u left join public.profiles p on p.id = u.id where u.id = auth.uid();
  select * into v_review from public.pj_sync_review where id = p_review_id for update;
  if not found then raise exception 'ไม่พบแถวกล่องรอตรวจนี้: %', p_review_id; end if;
  if v_review.status <> 'pending' then raise exception 'แถวนี้ไม่ใช่สถานะรอตรวจแล้ว (status=%) — ผูกไม่ได้', v_review.status; end if;
  if v_review.reason not in ('STAFF_MANUAL_OVERLAP', 'RECEIPT_UNRECORDED') then raise exception 'แถวนี้ไม่ใช่เคส STAFF_MANUAL_OVERLAP/RECEIPT_UNRECORDED (reason=%) — ห้ามผูกจากฟังก์ชันนี้', v_review.reason; end if;
  if v_review.reason = 'RECEIPT_UNRECORDED' and coalesce(v_review.pj_payment_type, '') not in ('installment', 'penalty', 'ค่างวด', 'ค่าปรับ') then raise exception 'แถวนี้เป็นใบประเภท % ผูกกับรายการที่พนักงานลงไม่ได้', coalesce(v_review.pj_payment_type, '-'); end if;
  if v_review.matched_contract_id is null then raise exception 'แถวนี้ไม่มีสัญญาที่ตรง (matched_contract_id เป็น null) — ผูกไม่ได้'; end if;
  if v_review.raw_json is null or jsonb_typeof(v_review.raw_json) <> 'array' then
    raise exception 'raw_json ของแถวนี้ไม่ใช่ array ใบเสร็จ (รูปแบบไม่ตรง) — ผูกอัตโนมัติไม่ได้ ต้องตรวจมือ';
  end if;
  for v_receipt in
    select nullif(trim(elem ->> 'uuid'), '') as uuid,
      coalesce(nullif(regexp_replace(coalesce(elem ->> 'amount', ''), '[^0-9.\-]', '', 'g'), '')::numeric, 0) as amount,
      elem ->> 'payment_type' as payment_type,
      coalesce(elem ->> 'invoice_no', v_review.pj_invoice_no) as invoice_no,
      elem ->> 'paid_date' as paid_date_raw
    from jsonb_array_elements(v_review.raw_json) as elem
  loop
    if v_receipt.uuid is null then continue; end if;
    if v_receipt.uuid = any(v_uuids) then continue; end if;
    v_uuids := array_append(v_uuids, v_receipt.uuid);
    v_total_amount := v_total_amount + v_receipt.amount;
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object('uuid', v_receipt.uuid, 'amount', v_receipt.amount, 'payment_type', v_receipt.payment_type, 'invoice_no', v_receipt.invoice_no, 'paid_date_raw', v_receipt.paid_date_raw));
  end loop;
  if array_length(v_uuids, 1) is null or array_length(v_uuids, 1) = 0 then raise exception 'raw_json ของแถวนี้ไม่มีใบเสร็จที่มี uuid เลย — ผูกไม่ได้'; end if;
  select array_agg(pj_receipt_uuid) into v_conflicting from public.pj_applied_receipts where pj_receipt_uuid = any(v_uuids);
  if v_conflicting is not null and array_length(v_conflicting, 1) > 0 then
    raise exception 'ใบเสร็จบางใบถูกลงไปแล้ว (ชนกับ cron หรือคนอื่นลงไปก่อนหน้า): %', array_to_string(v_conflicting, ', ');
  end if;
  select * into v_log from public.payment_log where id = p_payment_log_id for update;
  if not found then raise exception 'ไม่พบรายการที่พนักงานลงมือ (payment_log id: %)', p_payment_log_id; end if;
  if v_log.contract_id <> v_review.matched_contract_id then raise exception 'สัญญาของรายการที่พนักงานลงมือไม่ตรงกับสัญญาของกล่องรอตรวจนี้'; end if;
  if v_log.action <> 'pay' or v_log.amount <= 0 or v_log.acted_by is null then raise exception 'รายการนี้ไม่ใช่การจ่ายที่พนักงานลงมือ (ต้อง action=pay, amount>0, มี acted_by)'; end if;
  if exists (select 1 from public.payment_log c where c.installment_id = v_log.installment_id and c.action = 'cancel' and c.created_at > v_log.created_at) then
    raise exception 'รายการนี้ถูกยกเลิกไปแล้วหลังจากลงมือ ผูกไม่ได้';
  end if;
  select public.pj_staff_log_capacity_left(v_log.id) into v_capacity_left;
  if v_capacity_left < v_total_amount - 20 then
    raise exception 'ยอดที่เหลือของรายการที่พนักงานลงมือไม่พอผูก (เหลือ % บาท ต้องการผูก % บาท)', round(v_capacity_left, 2), round(v_total_amount, 2);
  end if;
  insert into public.pj_applied_receipts (pj_receipt_uuid, contract_id, pj_invoice_no, pj_paid_date, amount, payment_type, source, payment_log_id, applied_at)
  select elem ->> 'uuid', v_review.matched_contract_id, elem ->> 'invoice_no', v_review.pj_paid_date, (elem ->> 'amount')::numeric, elem ->> 'payment_type', 'staff-link', v_log.id, now()
  from jsonb_array_elements(v_receipts) as elem;
  get diagnostics v_inserted = row_count;
  v_linked_json := v_receipts;
  update public.pj_sync_review
     set status = 'resolved', resolved_by = v_by_name, resolved_at = now(),
         resolution_note = trim(concat('ผูกกับรายการที่พนักงานลงมือ (payment_log ', v_log.id::text, ', ', coalesce(nullif(v_log.by_name, ''), '?'), ', ', to_char(v_log.created_at at time zone 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI'), ')', case when p_note is not null and trim(p_note) <> '' then ' — ' || trim(p_note) else '' end)),
         overlap_detail = coalesce(overlap_detail, '{}'::jsonb) || jsonb_build_object('link', jsonb_build_object('linked_payment_log_id', v_log.id, 'linked_receipts', v_linked_json, 'linked_receipt_count', v_inserted, 'linked_at', now(), 'linked_by', v_by_name))
   where id = p_review_id;
end;
$function$;

revoke all on function public.link_pj_review_to_payment_log(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.link_pj_review_to_payment_log(uuid, uuid, text) to authenticated, service_role;

comment on function public.link_pj_review_to_payment_log(uuid, uuid, text) is
  '(0162 + 20261119140000 รับ RECEIPT_UNRECORDED เพิ่ม) ผูกแถวกล่องรอตรวจ PJ (ต้อง status=pending, reason=STAFF_MANUAL_OVERLAP หรือ RECEIPT_UNRECORDED) เข้ากับ payment_log ที่พนักงานลงมือไปแล้ว — insert pj_applied_receipts (source=staff-link) + resolve แถว + merge overlap_detail.link; admin/staff (active) เท่านั้น';

-- ============================================================================
-- SECTION 3: apply_pj_review_payment (0183) — เติม guard เดียว: แถว RECEIPT_UNRECORDED ประเภท "other" ห้ามลงเป็นค่างวด
-- (ถ้าปล่อย จะถูกลงเป็นเงินต้นผิดประเภท — ต้องปิดเป็นรายได้อื่นๆ ผ่าน apply_pj_review_other_income เท่านั้น)
-- ที่เหลือ copy จาก 0183 ตรงตัว (ครีมยืนยัน md5 live == 0183) — ถ้า live เปลี่ยนก่อน apply ให้ re-copy จาก live
-- ============================================================================

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
  -- (20261119140000) ใบ "อื่นๆ" ที่ตัวตรวจจับได้ ห้ามลงเป็นค่างวด — ปิดเป็นรายได้อื่นๆ เท่านั้น
  -- (20261119140000) ติ๊ก Y1: แถวที่ตัวตรวจติดธง applyBlocked (สัญญาปิด/คืนเครื่อง/สถานะไม่ปกติ) ห้ามลงเงินจากกล่องนี้
  if coalesce((v_rev.overlap_detail ->> 'applyBlocked')::boolean, false) then
    raise exception '[PJR:MANUAL_ONLY] รายการนี้สัญญาไม่ใช่ผ่อนปกติ (ปิด/คืนเครื่อง/อื่นๆ) ต้องตรวจและจัดการมือ';
  end if;
  -- พนักงานลงเงินไปแล้ว (เคสตัวตรวจจับคู่) — ต้องผูกด้วย link_pj_review_to_payment_log ห้ามลงซ้ำ
  if v_rev.reason = 'STAFF_MANUAL_OVERLAP' and v_rev.detector_batch is not null then
    raise exception '[PJR:MANUAL_ONLY] รายการนี้พนักงานลงเงินไปแล้ว ให้กดผูกกับรายการที่พนักงานลง ห้ามลงซ้ำ';
  end if;
  if v_rev.reason = 'RECEIPT_UNRECORDED' and coalesce(v_rev.pj_payment_type, '') not in ('installment', 'penalty') then
    raise exception '[PJR:MANUAL_ONLY] ใบประเภทนี้ (%) ลงเป็นค่างวดไม่ได้ ให้บันทึกเป็นรายได้อื่นๆ', coalesce(v_rev.pj_payment_type, '-');
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
  '(0183 + 20261119140000) ลงเงินจากปุ่ม "ลงตาม PJ" แบบ atomic: ล็อกแถว pending + เช็คใบเสร็จยังไม่ลง + claim uuid + record_payment_spread + ledger + ปิดแถว; admin/staff active; ห้าม reason RECEIPT_MISSING/CHANGED/RETURNED_*/CONTRACT_CLOSED; RECEIPT_UNRECORDED ประเภท other ลงไม่ได้ (ต้องเป็นรายได้อื่นๆ)';

-- ============================================================================
-- SECTION 4: apply_pj_review_other_income (0183) — เติมกัน RECEIPT_UNRECORDED ที่เป็นค่างวด/ค่าปรับ ถูกปิดเป็น "รายได้อื่นๆ"
-- (ต้นเหตุเดิม: staff ปิดแถว OTHER เป็นรายได้อื่นๆ แล้วใบค่างวดที่อยู่ใน raw_json ถูกนับว่า handled เงียบ)
-- copy จาก 0183 ทุกบรรทัด เพิ่ม guard เดียว (ต่อจาก MANUAL_ONLY เดิม); ที่เหลือเหมือนเดิมเป๊ะ
-- ใบ RECEIPT_UNRECORDED ที่ pj_payment_type เป็น other/อื่นๆ ยังปิดเป็นรายได้อื่นๆ ได้ตามปกติ
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
  -- (20261119140000) ใบค่างวด/ค่าปรับที่ตัวตรวจจับได้ว่า "ไม่เคยถูกลง" ห้ามปิดเป็นรายได้อื่นๆ — ต้องลงตาม PJ หรือผูกกับรายการที่พนักงานลงเอง
  -- (20261119140000) ติ๊ก Y1: applyBlocked ห้ามปิดเป็นรายได้อื่นๆ ผ่านกล่องนี้ ต้องตรวจมือ
  if coalesce((v_rev.overlap_detail ->> 'applyBlocked')::boolean, false) then
    raise exception '[PJR:MANUAL_ONLY] รายการนี้สัญญาไม่ใช่ผ่อนปกติ (ปิด/คืนเครื่อง/อื่นๆ) ต้องตรวจและจัดการมือ';
  end if;
  if v_rev.reason = 'RECEIPT_UNRECORDED' and coalesce(v_rev.pj_payment_type, '') in ('installment', 'penalty', 'ค่างวด', 'ค่าปรับ') then
    raise exception '[PJR:UNRECORDED_RECEIPT] ใบเสร็จค่างวด/ค่าปรับที่ยังไม่ถูกลง ห้ามปิดเป็นรายได้อื่นๆ — ให้ลงตาม PJ หรือผูกกับรายการที่พนักงานลงเอง';
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
  '(0183 + 20261119140000) บันทึกรายได้อื่นๆ จากกล่องรอตรวจ atomic: ล็อกแถว pending + insert other_income + ปิดแถว resolved ใน tx เดียว; admin/staff active; ห้าม reason drift/RETURNED_*/CONTRACT_CLOSED; ห้าม RECEIPT_UNRECORDED ที่เป็นค่างวด/ค่าปรับ (ต้องลงตาม PJ หรือผูกกับรายการที่พนักงานลงเอง); วันที่ผูกกับ pj_paid_date; ยอดกรอกเองได้ (>0)';

-- ============================================================================
-- VERIFY (ครีมรันหลัง apply — ห้ามอยู่ใน migration จริง; ส่วน DML อยู่ใน begin...rollback เหมือน 0131)
-- ============================================================================
-- V1) schema:
--   select column_name from information_schema.columns where table_schema='public' and table_name='pj_sync_review'
--     and column_name in ('detector_batch','pj_receipt_uuid','overlap_detail');                       -- 3 แถว
--   select indexdef from pg_indexes where indexname='pj_sync_review_unrecorded_uuid_uidx';            -- where (reason = 'RECEIPT_UNRECORDED')
--   select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.pj_sync_review'::regclass and contype='c'; -- ต้องไม่มี check เรื่อง reason
-- V2) สิทธิ์ (anon ต้อง false ทั้งคู่):
--   select has_function_privilege('anon','public.link_pj_review_to_payment_log(uuid,uuid,text)','execute');                         -- false
--   select has_function_privilege('authenticated','public.link_pj_review_to_payment_log(uuid,uuid,text)','execute');                -- true
--   select has_function_privilege('anon','public.apply_pj_review_other_income(uuid,numeric,text,date,text,text)','execute');       -- false
--   select has_function_privilege('authenticated','public.apply_pj_review_other_income(uuid,numeric,text,date,text,text)','execute'); -- true
--   select has_table_privilege('service_role','public.pj_sync_review','INSERT');                                                    -- true
-- V3) idempotent insert + guard other_income (rollback ทิ้งหมด; ใช้สัญญา+uuid ทดสอบที่ไม่มีใน pj_applied_receipts):
--   begin;
--   insert into public.pj_sync_review (pj_invoice_no, pj_payment_type, pj_amount, pj_paid_date, matched_contract_id, reason, raw_json, pj_receipt_uuid, detector_batch)
--     select c.inv_no, 'installment', 700, current_date, c.id, 'RECEIPT_UNRECORDED',
--            '[{"uuid":"TEST-UNREC-1","amount":"700","payment_type":"installment"}]'::jsonb, 'TEST-UNREC-1', 'test'
--       from public.contracts c where c.status='active' and c.inv_no is not null limit 1;
--   insert into public.pj_sync_review (pj_invoice_no, pj_payment_type, pj_amount, pj_paid_date, matched_contract_id, reason, raw_json, pj_receipt_uuid, detector_batch)
--     select pj_invoice_no, pj_payment_type, pj_amount, pj_paid_date, matched_contract_id, reason, raw_json, pj_receipt_uuid, detector_batch
--       from public.pj_sync_review where pj_receipt_uuid='TEST-UNREC-1'
--     on conflict (pj_receipt_uuid) where reason in ('RECEIPT_UNRECORDED','STAFF_MANUAL_OVERLAP') and detector_batch is not null do nothing;
--   select count(*) from public.pj_sync_review where pj_receipt_uuid='TEST-UNREC-1';                -- 1 (ไม่เบิ้ล)
--   -- จำลองแอดมิน: select set_config('request.jwt.claims', json_build_object('sub','<admin uuid>','role','authenticated')::text, true);
--   --   set local role authenticated;
--   --   select public.apply_pj_review_other_income((select id from public.pj_sync_review where pj_receipt_uuid='TEST-UNREC-1'),
--   --          700, 'x', current_date, null, null);                                              -- ต้อง raise [PJR:UNRECORDED_RECEIPT]
--   rollback;
