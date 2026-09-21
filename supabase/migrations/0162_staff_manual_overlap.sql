-- 0162: กันระบบ pj-sync ลงเงินซ้ำกับที่พนักงานลงมือรับชำระไปแล้วมือ (Staff Manual Overlap Gate)
-- อนุมัติคุณเตย 21 ก.ย. 2026
--
-- ปัญหา: พนักงานลงรับชำระมือจาก PaymentModal (ContractDetail.tsx → RPC record_payment_with_penalty,
-- mig 0040) โดยไม่ผ่านกล่องรอตรวจ PJ → payment_log แถวนั้นไม่ได้ผูกกับใบเสร็จ PJ ใดเลย → pj-sync
-- (supabase/functions/pj-sync/index.ts, branch เงินเข้า ~บรรทัด 1757) เห็นใบเสร็จเดียวกันจาก PJ แล้ว
-- ลงซ้ำอีกรอบ (หรือกลับกัน คนลงมือหลังจากที่ PJ ลงไปแล้ว) — ตั้งแต่ ก.ค. 2026 มีลงมือนอกกล่อง ~24 รายการ
-- ซ้ำจริง ~7 ราย (ครีมสอบละเอียดแล้ว)
--
-- ผล recon (ครีม, ก่อนเขียน migration นี้):
--   - "คน" = payment_log.acted_by IS NOT NULL (trigger set_payment_log_actor ตั้งจาก auth.uid() ปลอมไม่ได้)
--     ระบบ/PJ Auto-Sync/Data Fix/ครีม MCP = NULL เสมอ
--   - link "same-transaction" เดิม (ไม่ใช่ของ migration นี้ — เป็น correlation สังเกตได้จากข้อมูล):
--     pj_applied_receipts.applied_at = payment_log.created_at (contract เดียวกัน) ตรง 98.9% ของใบ
--     auto/review และ 99.9% ของ log ที่มาจาก PJ Auto-Sync เอง → บอกว่า log แถวนั้น "ผูกใบไปแล้วโดยธรรมชาติ"
--     ไม่ต้อง backfill อะไร ใช้เป็นเงื่อนไข capacity_left=0 ด้านล่างได้เลย
--   - pj_applied_receipts.payment_log_id ไม่เคยถูกเติมมาก่อน (0/3,325 แถว ณ วันที่ตรวจ) — migration นี้เป็น
--     จุดแรกที่เติมคอลัมน์นี้จริง (เฉพาะแถวใหม่ source='staff-link' เท่านั้น — ไม่ backfill แถวเก่า)
--   - backtest ประตูใหม่ (กลุ่มใบ auto ที่มี human log ไม่ผูกใบ ในช่วง paid_date±10 วัน): ก.ค.(ครึ่งเดือน) 13 /
--     ส.ค. 5 / ก.ย. 8 กลุ่ม → เข้ากล่องไม่เกิน ~15 เคส/เดือน (ปริมาณจัดการได้)
--   - pj_applied_receipts ไม่มี grant ให้ authenticated เลย (ล็อกไว้ตั้งแต่ 0132 — anon/authenticated ถูก
--     revoke all + เปิด RLS ไม่มี policy) → ทุกฟังก์ชันในไฟล์นี้ที่แตะตารางนี้ต้องเป็น SECURITY DEFINER
--     (รันด้วยสิทธิ์เจ้าของฟังก์ชัน ไม่ใช่สิทธิ์ authenticated ของผู้เรียก — ตรงกับ pattern ที่ record_payment_spread
--     0100 ใช้อยู่แล้วในการ insert ตารางนี้)
--
-- Scope งานรอบนี้ (Wave 1) — เขียนแค่ "เครื่องมือ" (schema + RPC) เท่านั้น ไม่แตะ pj-sync/index.ts และไม่แตะ
-- UI/db.ts เลย (คนละ wave, คนละ specialist) — reason='STAFF_MANUAL_OVERLAP' บนแถว pj_sync_review เป็นสิ่งที่
-- Wave ถัดไปจะเป็นคน "ตั้ง" (เช่น admin กด flag จากผลของ find_staff_payment_overlap หรือ pj-sync เซ็ตเองตอน sync
-- ในอนาคต) — ฟังก์ชัน link_pj_review_to_payment_log ด้านล่างแค่ "เชื่อ" ว่าถ้าเจอ reason นี้ = ผ่านการตรวจแล้วจริง
--
-- ห้ามแก้ record_payment_spread (0100/0113/0115) / record_payment_with_penalty (0040) เลย — งานนี้เป็นแค่
-- "ชั้นดัก" คู่ขนาน ไม่ยุ่งกับ path ลงเงินเดิมทั้ง 2 เส้น (auto-sync กับ staff manual)
--
-- Additive/idempotent ทั้งไฟล์ — add column if not exists, create index if not exists, create or replace
-- function, revoke ก่อน grant ใหม่ทุกฟังก์ชัน (กันหลุดไป PUBLIC โดยไม่ตั้งใจ — Postgres grant EXECUTE ให้
-- PUBLIC อัตโนมัติตอน CREATE FUNCTION ถ้าไม่ revoke)

-- ============================================================================
-- SECTION 1: pj_sync_review.overlap_detail — คอลัมน์เสริม เก็บรายละเอียดตอนผูก (audit)
-- ⚠️ raw_json ยังคงเป็น array ใบเสร็จรูปแบบเดิมเป๊ะ (ห้ามเปลี่ยนรูป — extractPjPendingReceipts ใน
-- src/lib/db.ts ~8271 อ่านได้แค่ 3 รูป: array ตรงๆ / object RECEIPT_PARTIAL_APPLIED / object returned_watch)
-- overlap_detail เป็นคอลัมน์แยกต่างหาก nullable ใช้เก็บผลลัพธ์ตอนกด "ผูกกับรายการที่พนักงานลงมือ" เท่านั้น
-- (เขียนจาก link_pj_review_to_payment_log ด้านล่าง SECTION 5) — ไม่กระทบใครที่อ่าน raw_json อยู่เดิม
-- ============================================================================

alter table public.pj_sync_review
  add column if not exists overlap_detail jsonb;

comment on column public.pj_sync_review.overlap_detail is
  '(0162) รายละเอียดตอนผูกแถวนี้กับ payment_log ของพนักงาน (link_pj_review_to_payment_log เขียน) — {linked_payment_log_id, linked_receipts, linked_at, linked_by}; null = ยังไม่เคยผูก/ไม่เกี่ยวกับ overlap เลย';

-- ============================================================================
-- SECTION 2: index กันซ้ำ/ค้นเร็ว — pj_applied_receipts.payment_log_id (เฉพาะแถวที่ผูกแล้ว)
-- ============================================================================

create index if not exists pj_applied_receipts_payment_log_id_idx
  on public.pj_applied_receipts (payment_log_id)
  where payment_log_id is not null;

-- ============================================================================
-- SECTION 3: helper — pj_staff_log_capacity_left(p_log_id)
-- คำนวณ "เงินคงเหลือที่ยังผูกใบ PJ ได้" ของ 1 แถว payment_log (L) — ใช้ร่วมกันทั้ง 3 ฟังก์ชันด้านล่าง
-- (find_staff_payment_overlap / link_pj_review_to_payment_log / pj_staff_overlap_suspects) จุดเดียว
-- กันสูตรหลุดไม่ตรงกันระหว่างฟังก์ชัน (ความหมายต้อง identical เป๊ะเพราะฝั่ง link ใช้ค่านี้ตัดสินใจเขียนเงินจริง)
--
-- สูตร (จาก recon ด้านบน):
--   - ถ้ามี pj_applied_receipts ของ contract เดียวกันที่ applied_at = L.created_at (ตรงเป๊ะ) → ถือว่า L
--     ผูกใบไปแล้ว "โดยธรรมชาติ" (correlation 98.9%/99.9% จาก recon) → capacity_left = 0 กันผูกซ้ำอีกชั้น
--   - ไม่งั้น = L.amount − Σ(pj_applied_receipts.amount ที่ payment_log_id = L.id) — ส่วนที่ "ผูกไปแล้วจริง"
--     ผ่าน staff-link (source นี้) เท่านั้น หักออกจากยอดเต็มของ L
-- ⚠️ engine ภายใน ไม่ให้ authenticated เรียกตรง (grant service_role เท่านั้น — เรียกผ่าน 3 ฟังก์ชัน
-- SECURITY DEFINER ด้านล่างที่ห่อ guard สิทธิ์ไว้แล้วเท่านั้น เหมือน pattern npl_as_of/get_npl_history ใน 0159)
-- ============================================================================

create or replace function public.pj_staff_log_capacity_left(p_log_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case
    when exists (
      select 1
        from public.pj_applied_receipts par
       where par.contract_id = pl.contract_id
         and par.applied_at = pl.created_at
    )
    then 0::numeric
    else pl.amount - coalesce((
      select sum(par2.amount)
        from public.pj_applied_receipts par2
       where par2.payment_log_id = pl.id
    ), 0)
  end
  from public.payment_log pl
  where pl.id = p_log_id;
$$;

revoke all on function public.pj_staff_log_capacity_left(uuid) from public, anon, authenticated;
grant execute on function public.pj_staff_log_capacity_left(uuid) to service_role;

comment on function public.pj_staff_log_capacity_left(uuid) is
  '(0162) เงินคงเหลือของ payment_log แถว p_log_id ที่ยังผูกใบเสร็จ PJ ได้ — 0 ถ้ามีใบ pj_applied_receipts ที่ applied_at ตรงกับ payment_log.created_at เป๊ะ (ผูกไปแล้วโดย correlation ธรรมชาติ), ไม่งั้น = amount ลบยอดที่ผูกผ่าน staff-link ไปแล้ว; engine ภายใน service_role เท่านั้น เรียกผ่าน find_staff_payment_overlap/link_pj_review_to_payment_log/pj_staff_overlap_suspects';

-- ============================================================================
-- SECTION 4: find_staff_payment_overlap — หา payment_log ของพนักงานที่ "อาจจะ" เป็นก้อนเดียวกับ
-- ใบเสร็จ PJ (สัญญา+ช่วงวัน+ยอด) ให้ PaymentModal เตือนก่อนพนักงานลงมือซ้ำ + ให้กล่องรอตรวจ PJ แนะนำคู่ที่
-- น่าจะ match ให้แอดมิน/staff เลือกผูก
-- ============================================================================

create or replace function public.find_staff_payment_overlap(
  p_contract_id  uuid,
  p_paid_date    date,
  p_principal    numeric,
  p_penalty      numeric,
  p_window_days  int default 10
)
returns table (
  log_id              uuid,
  created_at          timestamptz,
  bangkok_paid_date   date,
  by_name             text,
  amount              numeric,
  penalty_paid_amount numeric,
  installment_no      int,
  capacity_left       numeric,
  match_kind          text
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role   text;
  v_active boolean;
  v_total  numeric := coalesce(p_principal, 0) + coalesce(p_penalty, 0);
begin
  -- guard: admin หรือ staff (active) เท่านั้น — pattern เดียวกับ 0142/0143/0157/0158 (is_admin() ไม่เช็ค
  -- active, is_staff() บังคับ role='staff' เป๊ะ ไม่ครอบ admin — ใช้เช็คมือให้ตรงเจตนา "admin หรือ staff" ตรงตัว)
  -- ฟังก์ชันอ่านอย่างเดียว → ไม่ผ่านเงื่อนไข = คืนว่าง ไม่ raise (เหมือน get_npl_history ใน 0159)
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    return;
  end if;

  if p_contract_id is null or p_paid_date is null then
    return;
  end if;

  return query
  select
    pl.id,
    pl.created_at,
    (pl.created_at at time zone 'Asia/Bangkok')::date,
    pl.by_name,
    pl.amount,
    pl.penalty_paid_amount,
    i.installment_no,
    cap.capacity_left,
    case
      when pl.amount = v_total then 'exact_total'
      when pl.amount - coalesce(pl.penalty_paid_amount, 0) = coalesce(p_principal, 0) then 'exact_principal'
      when abs(pl.amount - v_total) <= 20 then 'near'
      else 'other'
    end
  from public.payment_log pl
  left join public.installments i on i.id = pl.installment_id
  cross join lateral (select public.pj_staff_log_capacity_left(pl.id) as capacity_left) cap
  where pl.contract_id = p_contract_id
    and pl.action = 'pay'
    and pl.amount > 0
    and pl.acted_by is not null
    and (pl.created_at at time zone 'Asia/Bangkok')::date
        between (p_paid_date - p_window_days) and (p_paid_date + p_window_days)
    -- ไม่ถูกยกเลิก: ไม่มี payment_log action='cancel' บน installment เดียวกันหลัง L.created_at
    -- (pl.installment_id เป็น null ได้ถ้างวดถูกลบตอนขยายสัญญา — เทียบ null=null ไม่ true ใน SQL จึงถือว่า
    -- "ไม่ถูกยกเลิก" โดย default กรณีนี้ เป็น known limitation เล็กน้อย ไม่บล็อกการมองเห็น)
    and not exists (
      select 1 from public.payment_log c
      where c.installment_id = pl.installment_id
        and c.action = 'cancel'
        and c.created_at > pl.created_at
    )
    and cap.capacity_left > 20
  order by pl.created_at desc;
end;
$$;

revoke all on function public.find_staff_payment_overlap(uuid, date, numeric, numeric, int) from public, anon, authenticated;
grant execute on function public.find_staff_payment_overlap(uuid, date, numeric, numeric, int) to authenticated, service_role;

comment on function public.find_staff_payment_overlap(uuid, date, numeric, numeric, int) is
  '(0162) หา payment_log ของพนักงาน (acted_by ไม่ null, action=pay, ไม่ถูก cancel, capacity_left>20) ในสัญญาเดียวกัน ใกล้ p_paid_date ±p_window_days วัน — match_kind: exact_total (ยอดรวมตรงเป๊ะ) / exact_principal (หักค่าปรับแล้วตรงเงินต้น) / near (ต่างไม่เกิน 20 บาท) / other; admin/staff (active) เท่านั้น ไม่งั้นคืนว่าง';

-- ============================================================================
-- SECTION 5: link_pj_review_to_payment_log — ผูกแถวกล่องรอตรวจ (reason=STAFF_MANUAL_OVERLAP) เข้ากับ
-- payment_log ที่พนักงานลงมือไปแล้ว แทนการลงเงินซ้ำ
--
-- 🚨 ห้ามเขียน pj_applied_ledger (คีย์ contract+date หลวม จะชนกับ auto-sync legacy path) และห้าม UPDATE
-- payment_log เด็ดขาด (payment_log เป็น audit log ห้ามแก้ไขข้อมูลเดิม — เขียนแค่ pj_applied_receipts +
-- resolve แถว pj_sync_review เท่านั้น)
--
-- Runbook ผูกผิด: ครีมลบแถว source='staff-link' ที่ผูกผิดออกจาก pj_applied_receipts ตรงๆ (DELETE, มี
-- superuser ผ่าน MCP) → deep-scan ของ pj-sync รอบถัดไปจะเห็นว่า uuid นี้ "ยังไม่เคยลง" แล้วหยิบใบเสร็จนั้น
-- กลับมาพิจารณาใหม่เอง — ใช้ได้เฉพาะใบเสร็จที่ paid_date ยังอยู่ในหน้าต่าง deep-scan (ปกติ ~30 วันจาก
-- paid_date ของใบ) ถ้าเกินนั้นต้องลงมือแก้ไขข้อมูลเองแล้ว (ไม่มี auto-recovery)
-- ============================================================================

create or replace function public.link_pj_review_to_payment_log(
  p_review_id      uuid,
  p_payment_log_id uuid,
  p_note           text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role            text;
  v_active          boolean;
  v_by_name         text;
  v_review          public.pj_sync_review%rowtype;
  v_log             public.payment_log%rowtype;
  v_receipts        jsonb := '[]'::jsonb;
  v_receipt         record;
  v_total_amount    numeric := 0;
  v_uuids           text[] := '{}';
  v_conflicting     text[];
  v_capacity_left   numeric;
  v_linked_json     jsonb := '[]'::jsonb;
  v_inserted        int := 0;
begin
  -- ---------------------------------------------------------------------
  -- SECURITY GUARD: admin/staff (active) เท่านั้น — เหมือน find_staff_payment_overlap ด้านบน +
  -- precedent cutover_transfer_invoice (0158) — เขียนเงิน/แก้ audit → raise เสมอถ้าไม่ผ่าน (ไม่ silent)
  -- ---------------------------------------------------------------------
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    raise exception 'ไม่มีสิทธิ์ผูกรายการนี้ (ต้องเป็น admin หรือ staff ที่ยัง active)';
  end if;

  select coalesce(nullif(p.full_name, ''), u.email, '') into v_by_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = auth.uid();

  -- ---------------------------------------------------------------------
  -- 1) ล็อกแถวกล่องรอตรวจ ต้อง pending + reason=STAFF_MANUAL_OVERLAP เท่านั้น
  -- (reason นี้เป็นสิ่งที่ Wave ถัดไปเป็นคนตั้ง — ฟังก์ชันนี้แค่เชื่อว่าผ่านการตรวจแล้วจริงถ้าเจอ reason ตรง)
  -- ---------------------------------------------------------------------
  select * into v_review from public.pj_sync_review where id = p_review_id for update;
  if not found then
    raise exception 'ไม่พบแถวกล่องรอตรวจนี้: %', p_review_id;
  end if;
  if v_review.status <> 'pending' then
    raise exception 'แถวนี้ไม่ใช่สถานะรอตรวจแล้ว (status=%) — ผูกไม่ได้', v_review.status;
  end if;
  if v_review.reason <> 'STAFF_MANUAL_OVERLAP' then
    raise exception 'แถวนี้ไม่ใช่เคส STAFF_MANUAL_OVERLAP (reason=%) — ห้ามผูกจากฟังก์ชันนี้', v_review.reason;
  end if;
  if v_review.matched_contract_id is null then
    raise exception 'แถวนี้ไม่มีสัญญาที่ตรง (matched_contract_id เป็น null) — ผูกไม่ได้';
  end if;

  -- ---------------------------------------------------------------------
  -- 2) อ่านใบเสร็จจาก raw_json ฝั่ง server (ต้องเป็น array แบบเดิม — reason อื่นทั้งไฟล์ pj-sync/index.ts
  -- ใช้ a.raw ตรงๆ เป็น array ของแถวดิบจาก PJ: field uuid/amount/payment_type/paid_date(DD-MM-YYYY)/invoice_no)
  -- ---------------------------------------------------------------------
  if v_review.raw_json is null or jsonb_typeof(v_review.raw_json) <> 'array' then
    raise exception 'raw_json ของแถวนี้ไม่ใช่ array ใบเสร็จ (รูปแบบไม่ตรง) — ผูกอัตโนมัติไม่ได้ ต้องตรวจมือ';
  end if;

  for v_receipt in
    select
      nullif(trim(elem ->> 'uuid'), '')                                            as uuid,
      coalesce(nullif(regexp_replace(coalesce(elem ->> 'amount', ''), '[^0-9.\-]', '', 'g'), '')::numeric, 0) as amount,
      elem ->> 'payment_type'                                                      as payment_type,
      coalesce(elem ->> 'invoice_no', v_review.pj_invoice_no)                      as invoice_no,
      elem ->> 'paid_date'                                                         as paid_date_raw
    from jsonb_array_elements(v_review.raw_json) as elem
  loop
    if v_receipt.uuid is null then
      continue; -- แถวไม่มี uuid ใน raw ดิบ — ข้าม (เหมือน extractPjPendingReceipts ฝั่ง client)
    end if;
    if v_receipt.uuid = any(v_uuids) then
      -- กัน uuid ซ้ำกันเองภายใน raw_json เดียว (pagination race ตอน deep-scan ดึงหน้าเดียวกันมา 2 รอบ —
      -- เจอปัญหาเดียวกันนี้มาแล้วที่ pj-sync/index.ts "ติ๊ก review YELLOW3 fix") — ไม่งั้น INSERT ด้านล่าง
      -- จะชน primary key (pj_receipt_uuid ซ้ำในชุดเดียวกัน) แล้ว error ดิบไม่เป็นมิตร
      continue;
    end if;
    v_uuids := array_append(v_uuids, v_receipt.uuid);
    v_total_amount := v_total_amount + v_receipt.amount;
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object(
      'uuid', v_receipt.uuid,
      'amount', v_receipt.amount,
      'payment_type', v_receipt.payment_type,
      'invoice_no', v_receipt.invoice_no,
      'paid_date_raw', v_receipt.paid_date_raw
    ));
  end loop;

  if array_length(v_uuids, 1) is null or array_length(v_uuids, 1) = 0 then
    raise exception 'raw_json ของแถวนี้ไม่มีใบเสร็จที่มี uuid เลย — ผูกไม่ได้';
  end if;

  -- ---------------------------------------------------------------------
  -- 3) กันชนกับ cron/มือคนอื่น — ถ้ามี uuid ใดถูกลงไปแล้วใน pj_applied_receipts ห้ามผูกทับ
  -- ---------------------------------------------------------------------
  select array_agg(pj_receipt_uuid) into v_conflicting
    from public.pj_applied_receipts
   where pj_receipt_uuid = any(v_uuids);

  if v_conflicting is not null and array_length(v_conflicting, 1) > 0 then
    raise exception 'ใบเสร็จบางใบถูกลงไปแล้ว (ชนกับ cron หรือคนอื่นลงไปก่อนหน้า): %', array_to_string(v_conflicting, ', ');
  end if;

  -- ---------------------------------------------------------------------
  -- 4) ล็อก + ตรวจ payment_log เป้าหมาย (L)
  -- ---------------------------------------------------------------------
  select * into v_log from public.payment_log where id = p_payment_log_id for update;
  if not found then
    raise exception 'ไม่พบรายการที่พนักงานลงมือ (payment_log id: %)', p_payment_log_id;
  end if;
  if v_log.contract_id <> v_review.matched_contract_id then
    raise exception 'สัญญาของรายการที่พนักงานลงมือไม่ตรงกับสัญญาของกล่องรอตรวจนี้';
  end if;
  if v_log.action <> 'pay' or v_log.amount <= 0 or v_log.acted_by is null then
    raise exception 'รายการนี้ไม่ใช่การจ่ายที่พนักงานลงมือ (ต้อง action=pay, amount>0, มี acted_by)';
  end if;
  if exists (
    select 1 from public.payment_log c
    where c.installment_id = v_log.installment_id
      and c.action = 'cancel'
      and c.created_at > v_log.created_at
  ) then
    raise exception 'รายการนี้ถูกยกเลิกไปแล้วหลังจากลงมือ ผูกไม่ได้';
  end if;

  -- capacity คำนวณ "หลัง" ล็อกแถว payment_log แล้ว (for update ด้านบน serialize คนที่แย่งผูกแถวเดียวกัน
  -- พร้อมกัน — คนที่ 2 จะรอจนคนแรก commit แล้วเห็น capacity ที่หักไปแล้วจริง กันผูกเบิ้ลเกินยอด L)
  select public.pj_staff_log_capacity_left(v_log.id) into v_capacity_left;
  if v_capacity_left < v_total_amount - 20 then
    raise exception 'ยอดที่เหลือของรายการที่พนักงานลงมือไม่พอผูก (เหลือ % บาท ต้องการผูก % บาท)',
      round(v_capacity_left, 2), round(v_total_amount, 2);
  end if;

  -- ---------------------------------------------------------------------
  -- 5) INSERT pj_applied_receipts ทุกใบ (source='staff-link') — pj_paid_date ใช้ค่าจากแถว review
  -- (v_review.pj_paid_date, ปกติเป็นวันเดียวกันทุกใบอยู่แล้ว — aggMap ฝั่ง pj-sync คีย์ด้วย invoice+paid_date
  -- ร่วมกัน) ไม่ parse paid_date ดิบ DD-MM-YYYY จาก raw_json ต่อใบซ้ำ กันพลาดรูปแบบวันที่แปลกจาก PJ
  -- ---------------------------------------------------------------------
  insert into public.pj_applied_receipts (
    pj_receipt_uuid, contract_id, pj_invoice_no, pj_paid_date, amount, payment_type, source, payment_log_id, applied_at
  )
  select
    elem ->> 'uuid',
    v_review.matched_contract_id,
    elem ->> 'invoice_no',
    v_review.pj_paid_date,
    (elem ->> 'amount')::numeric,
    elem ->> 'payment_type',
    'staff-link',
    v_log.id,
    now()
  from jsonb_array_elements(v_receipts) as elem;

  get diagnostics v_inserted = row_count;
  v_linked_json := v_receipts;

  -- ---------------------------------------------------------------------
  -- 6) resolve แถวกล่องรอตรวจ + เขียน overlap_detail (audit)
  -- ---------------------------------------------------------------------
  update public.pj_sync_review
     set status          = 'resolved',
         resolved_by     = v_by_name,
         resolved_at     = now(),
         resolution_note = trim(
           concat(
             'ผูกกับรายการที่พนักงานลงมือ (payment_log ', v_log.id::text,
             ', ', coalesce(nullif(v_log.by_name, ''), '?'),
             ', ', to_char(v_log.created_at at time zone 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI'), ')',
             case when p_note is not null and trim(p_note) <> '' then ' — ' || trim(p_note) else '' end
           )
         ),
         overlap_detail  = jsonb_build_object(
           'linked_payment_log_id', v_log.id,
           'linked_receipts',       v_linked_json,
           'linked_receipt_count',  v_inserted,
           'linked_at',             now(),
           'linked_by',             v_by_name
         )
   where id = p_review_id;
end;
$$;

revoke all on function public.link_pj_review_to_payment_log(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.link_pj_review_to_payment_log(uuid, uuid, text) to authenticated, service_role;

comment on function public.link_pj_review_to_payment_log(uuid, uuid, text) is
  '(0162) ผูกแถวกล่องรอตรวจ PJ (ต้อง status=pending, reason=STAFF_MANUAL_OVERLAP) เข้ากับ payment_log ที่พนักงานลงมือไปแล้ว — insert pj_applied_receipts (source=staff-link) กันคำนวณซ้ำของ pj-sync + resolve แถว ไม่แตะ pj_applied_ledger/payment_log เลย; admin/staff (active) เท่านั้น ผูกผิด → ลบแถว source=staff-link ออกจาก pj_applied_receipts มือ (ครีม/MCP) แล้วรอ deep-scan รอบถัดไปหยิบกลับ (ใช้ได้ใน ~30 วันจาก paid_date เท่านั้น)';

-- ============================================================================
-- SECTION 6: get_contract_pj_money_recent — สรุปเงิน PJ ล่าสุดของสัญญาเดียว ให้ PaymentModal เตือนก่อนพนักงาน
-- กดลงมือ (เห็นทั้งใบที่ลงแล้ว + แถวกล่องรอตรวจที่ยังค้างของสัญญานี้)
-- ============================================================================

create or replace function public.get_contract_pj_money_recent(
  p_contract_id uuid,
  p_days        int default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role    text;
  v_active  boolean;
  v_applied jsonb;
  v_pending jsonb;
begin
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    return null; -- ไม่ผ่านสิทธิ์ → null (caller ฝั่ง db.ts ต้อง treat เป็น "ไม่มีข้อมูล" ไม่ใช่ error)
  end if;

  if p_contract_id is null then
    return jsonb_build_object('applied', '[]'::jsonb, 'pending', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'paid_date',    par.pj_paid_date,
           'amount',       par.amount,
           'payment_type', par.payment_type,
           'source',       par.source,
           'applied_at',   par.applied_at
         ) order by par.applied_at desc), '[]'::jsonb)
    into v_applied
    from public.pj_applied_receipts par
   where par.contract_id = p_contract_id
     and par.pj_paid_date >= (current_date - greatest(coalesce(p_days, 10), 0));

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',           r.id,
           'reason',       r.reason,
           'pj_amount',    r.pj_amount,
           'pj_paid_date', r.pj_paid_date
         ) order by r.created_at desc), '[]'::jsonb)
    into v_pending
    from public.pj_sync_review r
   where r.matched_contract_id = p_contract_id
     and r.status = 'pending';

  return jsonb_build_object('applied', v_applied, 'pending', v_pending);
end;
$$;

revoke all on function public.get_contract_pj_money_recent(uuid, int) from public, anon, authenticated;
grant execute on function public.get_contract_pj_money_recent(uuid, int) to authenticated, service_role;

comment on function public.get_contract_pj_money_recent(uuid, int) is
  '(0162) สรุปเงิน PJ ล่าสุดของ 1 สัญญา ให้ PaymentModal เตือนก่อนลงมือ — {applied: pj_applied_receipts ของสัญญานี้ที่ pj_paid_date>=วันนี้-p_days, pending: แถวกล่องรอตรวจสถานะ pending ของสัญญานี้ (ไม่จำกัดวัน)}; admin/staff (active) เท่านั้น ไม่งั้นคืน null';

-- ============================================================================
-- SECTION 7: pj_staff_overlap_suspects — รายการต้องสงสัยทั้ง 2 ทิศ ให้แอดมิน triage
--   ทิศ 'pending_review'  = แถวกล่องรอตรวจที่ยัง "ไม่ถูกลงเงิน" (status=pending) ที่มี payment_log ของ
--                           พนักงานใกล้เคียงอยู่ — ป้องกันล่วงหน้า (ยังไม่มีเงินซ้ำเกิดขึ้นจริง)
--   ทิศ 'already_applied' = pj_applied_receipts ที่ลงไปแล้วจริง (source auto/review, ยังไม่เคยผูก
--                           payment_log_id) ที่มี payment_log ของพนักงานใกล้เคียงอยู่ — น่าสงสัยว่า "ซ้ำไปแล้ว"
--                           ต้องตรวจย้อนหลัง/คืนเงินถ้าใช่จริง (คนละความเร่งด่วนกับทิศแรก)
-- admin เท่านั้น (ไม่รวม staff — ข้อมูลกว้างระดับ "ทั้งระบบ" ต่างจาก find_staff_payment_overlap ที่ staff
-- ใช้แค่ระดับ 1 สัญญาที่กำลังทำงานอยู่)
-- ============================================================================

create or replace function public.pj_staff_overlap_suspects(
  p_window_days   int default 10,
  p_lookback_days int default 180
)
returns table (
  direction        text,
  review_id        uuid,
  receipt_uuid     text,
  contract_id      uuid,
  contract_no      text,
  customer_name    text,
  pj_reason        text,
  pj_amount        numeric,
  pj_paid_date     date,
  payment_log_id   uuid,
  log_created_at   timestamptz,
  log_by_name      text,
  log_amount       numeric,
  capacity_left    numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role   text;
  v_active boolean;
begin
  -- admin เท่านั้น (ไม่รวม staff — ต่างจากอีก 3 ฟังก์ชันด้านบน) ไม่ผ่าน → คืนว่าง ไม่ raise (อ่านอย่างเดียว)
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role <> 'admin' or v_active is not true then
    return;
  end if;

  return query
  -- ── ทิศ 1: pending_review ─────────────────────────────────────────────────
  select
    'pending_review'::text,
    r.id,
    null::text,
    r.matched_contract_id,
    c.contract_no,
    c.customer_name,
    r.reason,
    r.pj_amount,
    r.pj_paid_date,
    pl.id,
    pl.created_at,
    pl.by_name,
    pl.amount,
    cap.capacity_left
  from public.pj_sync_review r
  join public.contracts c on c.id = r.matched_contract_id
  join public.payment_log pl
    on pl.contract_id = r.matched_contract_id
   and pl.action = 'pay'
   and pl.amount > 0
   and pl.acted_by is not null
   and (pl.created_at at time zone 'Asia/Bangkok')::date
       between (r.pj_paid_date - p_window_days) and (r.pj_paid_date + p_window_days)
  cross join lateral (select public.pj_staff_log_capacity_left(pl.id) as capacity_left) cap
  where r.status = 'pending'
    and r.matched_contract_id is not null
    and r.pj_paid_date is not null
    -- ตัดเคส "manual-only" ที่ไม่มีทางลงเงินอัตโนมัติอยู่แล้ว (denylist เดียวกับ applyPjReviewPayment ฝั่ง
    -- client, src/lib/db.ts ~8719/8725) + ตัด STAFF_MANUAL_OVERLAP เอง (นั่นคือผลลัพธ์ของฟังก์ชันนี้ ไม่ใช่
    -- input — กันโชว์ซ้ำในกล่องรอตรวจปกติที่แอดมินเห็นอยู่แล้ว)
    and r.reason not in (
      'STAFF_MANUAL_OVERLAP', 'RECEIPT_MISSING', 'RECEIPT_CHANGED',
      'RETURNED_CONTRACT_PAYMENT', 'RETURNED_CONTRACT_OVERAGE', 'RETURNED_CONTRACT_OTHER_FEE'
    )
    and not exists (
      select 1 from public.payment_log cc
      where cc.installment_id = pl.installment_id
        and cc.action = 'cancel'
        and cc.created_at > pl.created_at
    )
    and cap.capacity_left > 20

  union all

  -- ── ทิศ 2: already_applied ───────────────────────────────────────────────
  select
    'already_applied'::text,
    null::uuid,
    par.pj_receipt_uuid,
    par.contract_id,
    c.contract_no,
    c.customer_name,
    par.payment_type,
    par.amount,
    par.pj_paid_date,
    pl.id,
    pl.created_at,
    pl.by_name,
    pl.amount,
    cap.capacity_left
  from public.pj_applied_receipts par
  join public.contracts c on c.id = par.contract_id
  join public.payment_log pl
    on pl.contract_id = par.contract_id
   and pl.action = 'pay'
   and pl.amount > 0
   and pl.acted_by is not null
   and par.pj_paid_date is not null
   and (pl.created_at at time zone 'Asia/Bangkok')::date
       between (par.pj_paid_date - p_window_days) and (par.pj_paid_date + p_window_days)
  cross join lateral (select public.pj_staff_log_capacity_left(pl.id) as capacity_left) cap
  where par.source in ('auto', 'review')
    and par.payment_log_id is null
    and par.pj_paid_date >= (current_date - greatest(coalesce(p_lookback_days, 180), 0))
    and not exists (
      select 1 from public.payment_log cc
      where cc.installment_id = pl.installment_id
        and cc.action = 'cancel'
        and cc.created_at > pl.created_at
    )
    and cap.capacity_left > 20

  order by 1, 11 desc;
end;
$$;

revoke all on function public.pj_staff_overlap_suspects(int, int) from public, anon, authenticated;
grant execute on function public.pj_staff_overlap_suspects(int, int) to authenticated, service_role;

comment on function public.pj_staff_overlap_suspects(int, int) is
  '(0162) รายการต้องสงสัยว่าเงินซ้ำระหว่างพนักงานลงมือกับ PJ ทั้ง 2 ทิศ — pending_review (ยังไม่ลงเงิน ป้องกันล่วงหน้า) / already_applied (ลงไปแล้วจริง สงสัยซ้ำ ต้องตรวจย้อนหลัง); admin (active) เท่านั้น ไม่งั้นคืนว่าง; service_role เรียกผ่าน RPC นี้จะได้ผลว่างเสมอเพราะ auth.uid() เป็น null (จงใจ ตาม convention 0159 get_npl_history — service_role ควร query ตารางตรงถ้าต้องการ bypass)';

-- ============================================================================
-- SECTION 8: Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 8a) คอลัมน์ใหม่มีอยู่จริง:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='pj_sync_review' AND column_name='overlap_detail';

-- 8b) index ใหม่มีอยู่จริง:
--   SELECT indexname FROM pg_indexes WHERE tablename='pj_applied_receipts' AND indexname='pj_applied_receipts_payment_log_id_idx';

-- 8c) service_role เรียก helper ภายในได้ (engine):
--   SELECT has_function_privilege('service_role', 'public.pj_staff_log_capacity_left(uuid)', 'execute'); -- true
--   SELECT has_function_privilege('authenticated', 'public.pj_staff_log_capacity_left(uuid)', 'execute'); -- false (เจตนา — engine ภายในเท่านั้น)

-- 8d) authenticated เรียก 3 ฟังก์ชันหลักได้ (guard เช็คสิทธิ์เองข้างใน):
--   SELECT has_function_privilege('authenticated', 'public.find_staff_payment_overlap(uuid,date,numeric,numeric,int)', 'execute'); -- true
--   SELECT has_function_privilege('authenticated', 'public.link_pj_review_to_payment_log(uuid,uuid,text)', 'execute'); -- true
--   SELECT has_function_privilege('authenticated', 'public.get_contract_pj_money_recent(uuid,int)', 'execute'); -- true
--   SELECT has_function_privilege('authenticated', 'public.pj_staff_overlap_suspects(int,int)', 'execute'); -- true

-- 8e) anon ต้องไม่มีสิทธิ์อะไรเลยกับฟังก์ชันในไฟล์นี้ (ทุกตัว false):
--   SELECT has_function_privilege('anon', 'public.find_staff_payment_overlap(uuid,date,numeric,numeric,int)', 'execute');
--   SELECT has_function_privilege('anon', 'public.link_pj_review_to_payment_log(uuid,uuid,text)', 'execute');
--   SELECT has_function_privilege('anon', 'public.get_contract_pj_money_recent(uuid,int)', 'execute');
--   SELECT has_function_privilege('anon', 'public.pj_staff_overlap_suspects(int,int)', 'execute');
--   SELECT has_function_privilege('anon', 'public.pj_staff_log_capacity_left(uuid)', 'execute');

-- 8f) ดูเคสจริง (ปรับ uuid ตามที่หาได้จาก contracts.inv_no) — ดูสคริปต์ทดสอบเต็มแยกต่างหาก (scratchpad
--   test_0162.sql) ไม่รวมเข้า migration นี้ เพราะต้องใช้ set_config จำลอง auth.uid() ซึ่งไม่ควรอยู่ในไฟล์ migrate จริง
