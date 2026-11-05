-- 0182: เลิกเตือน RECEIPT_CHANGED (kind='type') ผิด เพราะชื่อประเภทใบเสร็จเขียนคนละแบบ (ค่างวด vs installment)
--
-- ที่มา (5 พ.ย. 2026): pj_applied_receipts ที่ลงจากกล่องรอตรวจเก็บ payment_type เป็นคำไทย 'ค่างวด'/'ค่าปรับ'
-- แต่ pj-sync ส่ง snapshot เป็น 'installment'/'penalty' (ผ่าน classifyPjReceiptPaymentType) ตัวเทียบ SQL
-- (reconcile_pj_receipts 0114/0125) เทียบตรงตัว -> ใบที่ไม่ได้เปลี่ยนอะไรจริงถูกเตือนว่า "ประเภทเปลี่ยน"
-- (ตอนตรวจ 5 พ.ย. 2026 มีแถว RECEIPT_CHANGED ชนิด type ค้าง pending ประมาณ 21 แถว) แก้: normalize สองฝั่งเป็นหมวดเดียวกันก่อนเทียบ
--   ค่างวด/installment -> installment ; ค่าปรับ/penalty -> penalty ; เงินดาวน์/down/down_payment -> down ; อื่น ๆ -> other
-- (ตรงกับ classifyPjReceiptPaymentType ใน supabase/functions/pj-sync/receiptPaymentType.ts) ไม่แตะการตรวจใบหาย/ยอดเปลี่ยน/วันเปลี่ยน
-- additive: เพิ่มฟังก์ชันช่วย 1 ตัว + create or replace reconcile_pj_receipts ด้วย signature เดิมเป๊ะ (grant เดิมจาก 0114 ยังอยู่)
-- ส่วนที่เปลี่ยนจาก 0125 มีจุดเดียว: บรรทัดเทียบประเภท (ทำเครื่องหมาย 0182) — ไม่ลบ/แก้ข้อมูลใด ๆ

create or replace function public.pj_norm_receipt_type(p_type text)
returns text
language sql
immutable
set search_path = public, pg_catalog
as $$
  select case lower(regexp_replace(trim(coalesce(p_type, '')), '\s+', ' ', 'g'))
    when 'ค่างวด' then 'installment'
    when 'installment' then 'installment'
    when 'ค่าปรับ' then 'penalty'
    when 'penalty' then 'penalty'
    when 'เงินดาวน์' then 'down'
    when 'down' then 'down'
    when 'down_payment' then 'down'
    else 'other'
  end
$$;

revoke all on function public.pj_norm_receipt_type(text) from public;
grant execute on function public.pj_norm_receipt_type(text) to service_role;

create or replace function public.reconcile_pj_receipts(
  p_snapshot     jsonb,
  p_window_start date,
  p_window_end   date,
  p_snapshot_at  timestamptz,
  p_dry_run      boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_pj_rows          jsonb;
  v_truncated        boolean;
  v_pj_row_count     int;
  v_our_evaluable    int := 0;
  v_prev_run_count   int;
  v_sanity_ok        boolean := true;
  v_sanity_reason    text := null;
  v_evaluated        int := 0;
  v_missing_reported int := 0;
  v_changed_reported int := 0;
  v_details          jsonb := '[]'::jsonb;
  rec                record;
  v_pj_match         jsonb;
  v_ours_side        jsonb;
begin
  -- รองรับทั้ง {rows:[...], truncated:bool} (สัญญาจริงที่ Edge Function ส่ง) และ array ตรงๆ (defensive)
  if jsonb_typeof(p_snapshot) = 'array' then
    v_pj_rows   := p_snapshot;
    v_truncated := false;
  else
    v_pj_rows   := coalesce(p_snapshot -> 'rows', '[]'::jsonb);
    v_truncated := coalesce((p_snapshot ->> 'truncated')::boolean, false);
  end if;
  v_pj_row_count := jsonb_array_length(v_pj_rows);

  -- ourEvaluableCount (evaluateRunSanity.ourEvaluableCount) — ใบเสร็จของเราที่ "ควรตัดสินได้" รอบนี้:
  -- ผ่าน coverage floor + อยู่ใน window ที่ดึงมา + ผ่าน settle margin (>=30 นาทีตั้งแต่ apply)
  -- (0125) — ตัดใบเสร็จของสัญญา status in ('returned','returned_closed') ออก: PJ ซ่อนใบพวกนี้จาก feed
  -- ทั้งหมดโดยไม่เกี่ยวกับใบถูกลบ/แก้จริง → ไม่ควรถูกนับเป็น "ควรตัดสินได้" เลย
  select count(*) into v_our_evaluable
    from public.pj_applied_receipts r
    left join public.contracts c on c.id = r.contract_id
   where r.pj_paid_date is not null
     and r.pj_paid_date between p_window_start and p_window_end
     and r.applied_at >= '2026-07-13T00:00:00.000Z'::timestamptz          -- COVERAGE_FLOOR_ISO
     and p_snapshot_at - r.applied_at >= interval '30 minutes'            -- SETTLE_MARGIN_MS
     and (c.status is null or c.status not in ('returned', 'returned_closed')); -- 0125

  -- previous successful reconcile run row-count (ratio sanity check) — reuse คอลัมน์ receipts_fetched
  -- เดิมของ pj_sync_runs (ความหมายเดียวกัน: "PJ ตอบกลับมากี่แถวรอบนั้น") กรองเฉพาะ run_kind='reconcile'
  select receipts_fetched into v_prev_run_count
    from public.pj_sync_runs
   where run_kind = 'reconcile' and status = 'success'
   order by started_at desc
   limit 1;

  -- ── evaluateRunSanity (ต้องตรงกับ src/lib/pjReceiptDrift.ts เป๊ะ — ลำดับเงื่อนไขเดียวกัน) ──────────
  if v_pj_row_count = 0 and v_our_evaluable > 0 then
    v_sanity_ok := false;
    v_sanity_reason := format(
      'PJ ตอบกลับมา 0 แถว แต่เรามีใบเสร็จที่ต้องตรวจ %s ใบในรอบนี้ — น่าจะดึง PJ ไม่สำเร็จ (เช่น ลืมกดตัวกรอง/session หลุด) ไม่ใช่ใบถูกลบทั้งหมดจริง',
      v_our_evaluable
    );
  elsif v_truncated then
    v_sanity_ok := false;
    v_sanity_reason := 'ดึงข้อมูล PJ มาไม่ครบ (ชนจำนวนหน้าสูงสุดที่ดึงได้ต่อรอบ) — ผลตรวจรอบนี้ไม่น่าเชื่อถือ ต้องดึงให้ครบก่อนค่อยตัดสิน';
  elsif v_prev_run_count is not null and v_prev_run_count > 0 and v_pj_row_count < (v_prev_run_count * 0.5) then
    v_sanity_ok := false;
    v_sanity_reason := format(
      'PJ ตอบกลับมาแค่ %s แถว น้อยกว่าครึ่งของรอบก่อนที่สำเร็จ (%s แถว) — สงสัยดึงข้อมูลไม่ครบ ไม่ใช่ใบถูกลบจริงทั้งหมด',
      v_pj_row_count, v_prev_run_count
    );
  end if;

  if not v_sanity_ok then
    -- ok=false → ยกเลิกทั้งรอบ ไม่เขียนอะไรเลย (ไม่ใช่แค่ข้ามบางใบ) ตาม comment ใน pjReceiptDrift.ts
    return jsonb_build_object(
      'ok', false,
      'reason', v_sanity_reason,
      'dryRun', p_dry_run,
      'pjRowCount', v_pj_row_count,
      'ourEvaluableCount', v_our_evaluable
    );
  end if;

  -- ── loop ใบเสร็จของเราที่ "evaluable" รอบนี้ (ผ่านทั้ง 3 เกต + ไม่ใช่สัญญาคืนเครื่อง 0125) ──────────
  for rec in
    select r.pj_receipt_uuid, r.amount, r.payment_type, r.pj_paid_date, r.applied_at,
           r.missing_streak, r.contract_id, r.pj_invoice_no
      from public.pj_applied_receipts r
      left join public.contracts c on c.id = r.contract_id
     where r.pj_paid_date is not null
       and r.pj_paid_date between p_window_start and p_window_end
       and r.applied_at >= '2026-07-13T00:00:00.000Z'::timestamptz
       and p_snapshot_at - r.applied_at >= interval '30 minutes'
       and (c.status is null or c.status not in ('returned', 'returned_closed')) -- 0125
  loop
    v_evaluated := v_evaluated + 1;

    select elem into v_pj_match
      from jsonb_array_elements(v_pj_rows) elem
     where elem ->> 'uuid' = rec.pj_receipt_uuid
     limit 1;

    v_ours_side := jsonb_build_object(
      'amount', rec.amount,
      'paymentType', rec.payment_type,
      'pjPaidDate', to_char(rec.pj_paid_date, 'YYYY-MM-DD')
    );

    if v_pj_match is null then
      -- ── ไม่เจอ uuid ใน PJ เลย → nextMissingStreak = missing_streak+1, report เมื่อ >=2 ──────────────
      declare
        v_next_streak   int := rec.missing_streak + 1;
        v_report        boolean := v_next_streak >= 2;   -- MISSING_STREAK_THRESHOLD
        v_snapshot_json jsonb;
      begin
        v_details := v_details || jsonb_build_array(jsonb_build_object(
          'uuid', rec.pj_receipt_uuid, 'kind', 'missing',
          'reported', v_report, 'missingStreak', v_next_streak,
          'ours', v_ours_side, 'pj', null
        ));

        if v_report then
          v_missing_reported := v_missing_reported + 1;
          v_snapshot_json := jsonb_build_object(
            'kind', 'missing', 'checkedAt', p_snapshot_at,
            'missingStreak', v_next_streak, 'ours', v_ours_side, 'pj', null
          );
        end if;

        if not p_dry_run then
          update public.pj_applied_receipts
             set missing_streak    = v_next_streak,
                 drift_reported_at = case when v_report then coalesce(drift_reported_at, p_snapshot_at) else drift_reported_at end,
                 drift_kind        = case when v_report then coalesce(drift_kind, 'missing') else drift_kind end
           where pj_receipt_uuid = rec.pj_receipt_uuid;

          if v_report then
            insert into public.pj_sync_review (
              pj_invoice_no, pj_payment_type, pj_amount, pj_paid_date,
              matched_contract_id, reason, raw_json, status, pj_receipt_uuid
            ) values (
              coalesce(rec.pj_invoice_no, rec.pj_receipt_uuid), rec.payment_type, rec.amount, rec.pj_paid_date,
              rec.contract_id, 'RECEIPT_MISSING', v_snapshot_json, 'pending', rec.pj_receipt_uuid
            )
            on conflict (pj_receipt_uuid) where reason in ('RECEIPT_MISSING', 'RECEIPT_CHANGED') do nothing;
          end if;
        end if;
      end;
    else
      -- ── เจอ uuid ใน PJ → reset streak เสมอ, เทียบ amount → type → date ตามลำดับ ─────────────────
      declare
        v_pj_amount     numeric := nullif(v_pj_match ->> 'amount', '')::numeric;
        v_pj_type       text    := v_pj_match ->> 'payment_type';
        v_pj_date       text    := v_pj_match ->> 'paid_date';
        v_our_date      text    := to_char(rec.pj_paid_date, 'YYYY-MM-DD');
        v_kind          text    := null;
        v_pj_side       jsonb;
        v_snapshot_json jsonb;
      begin
        if abs(rec.amount - coalesce(v_pj_amount, rec.amount)) > 0.01 then
          v_kind := 'amount';
        elsif public.pj_norm_receipt_type(rec.payment_type) <> public.pj_norm_receipt_type(v_pj_type) then -- 0182: เทียบหลัง normalize
          v_kind := 'type';
        elsif v_our_date <> v_pj_date then
          v_kind := 'date';
        end if;

        if not p_dry_run then
          update public.pj_applied_receipts
             set missing_streak    = 0,
                 last_seen_in_pj_at = p_snapshot_at
           where pj_receipt_uuid = rec.pj_receipt_uuid;
        end if;

        if v_kind is not null then
          v_changed_reported := v_changed_reported + 1;
          v_pj_side := jsonb_build_object('amount', v_pj_amount, 'paymentType', v_pj_type, 'pjPaidDate', v_pj_date);
          v_snapshot_json := jsonb_build_object(
            'kind', v_kind, 'checkedAt', p_snapshot_at,
            'missingStreak', 0, 'ours', v_ours_side, 'pj', v_pj_side
          );

          v_details := v_details || jsonb_build_array(jsonb_build_object(
            'uuid', rec.pj_receipt_uuid, 'kind', v_kind, 'reported', true,
            'missingStreak', 0, 'ours', v_ours_side, 'pj', v_pj_side
          ));

          if not p_dry_run then
            update public.pj_applied_receipts
               set drift_reported_at = coalesce(drift_reported_at, p_snapshot_at),
                   drift_kind        = coalesce(drift_kind, v_kind)
             where pj_receipt_uuid = rec.pj_receipt_uuid;

            insert into public.pj_sync_review (
              pj_invoice_no, pj_payment_type, pj_amount, pj_paid_date,
              matched_contract_id, reason, raw_json, status, pj_receipt_uuid
            ) values (
              coalesce(rec.pj_invoice_no, rec.pj_receipt_uuid), rec.payment_type, rec.amount, rec.pj_paid_date,
              rec.contract_id, 'RECEIPT_CHANGED', v_snapshot_json, 'pending', rec.pj_receipt_uuid
            )
            on conflict (pj_receipt_uuid) where reason in ('RECEIPT_MISSING', 'RECEIPT_CHANGED') do nothing;
          end if;
        end if;
      end;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'dryRun', p_dry_run,
    'pjRowCount', v_pj_row_count,
    'ourEvaluableCount', v_our_evaluable,
    'evaluated', v_evaluated,
    'missingReported', v_missing_reported,
    'changedReported', v_changed_reported,
    'truncated', v_truncated,
    'details', v_details
  );
end;
$$;

comment on function public.reconcile_pj_receipts(jsonb, date, date, timestamptz, boolean) is
  'ตรวจจับใบเสร็จ PJ ที่หาย/ถูกแก้ (0114) — diff pj_applied_receipts กับ snapshot PJ ที่ Edge Function ส่งมา, update missing_streak/last_seen_in_pj_at/drift_reported_at + insert pj_sync_review (reason RECEIPT_MISSING/RECEIPT_CHANGED) แบบ atomic; p_dry_run=true = คำนวณอย่างเดียวไม่เขียนอะไร; ตรวจ+รายงานเท่านั้น ไม่แตะเงิน/installments เลย (Pete locked); 0182 — เทียบประเภทหลัง normalize (pj_norm_receipt_type); 0125 — exclude สัญญา status returned/returned_closed ออกจากการประเมิน (PJ ซ่อนใบเสร็จของสัญญากลุ่มนี้ทั้งหมดจาก feed โดยไม่เกี่ยวกับใบถูกลบ/แก้จริง — ดู mode returned_watch ใน pj-sync/index.ts สำหรับการตรวจเงินคืนเครื่องแทน)';

-- ตรวจหลัง apply (ไม่แก้ข้อมูล):
--   select has_function_privilege('service_role', 'public.pj_norm_receipt_type(text)', 'EXECUTE');
--   select public.pj_norm_receipt_type('ค่างวด'), public.pj_norm_receipt_type('Penalty'), public.pj_norm_receipt_type('อื่นๆ');
