-- 0125: กันมือถือชี้ผิด (false-positive) ตอน reconcile ใบเสร็จ PJ ของสัญญาที่ "คืนเครื่อง" แล้ว
--       + เปิดทางให้ pj-sync มี mode ใหม่ "returned_watch" (ตรวจเงินคืนเครื่องที่ PJ ซ่อนใบเสร็จ)
--
-- บั๊กต้นเรื่อง (23 ก.ค. 2026, พิสูจน์แล้วกับเคสมัทญา S00003PNQ081 / INV-1763803288):
--   PJ ซ่อนใบเสร็จ "ทุกใบ" ของ invoice ที่สถานะเป็น "คืนเครื่อง" ออกจาก receipts feed
--   (/manager/ajax/receipts) ย้อนหลังทั้งหมด — ไม่ใช่แค่ใบใหม่ที่จะมาในอนาคต แปลว่า:
--
--   1) reconcile_pj_receipts (0114) ที่ตรวจ "ใบเสร็จที่เราเคย apply ไปแล้ว ยังอยู่ใน PJ ไหม" จะเจอใบเสร็จ
--      ของสัญญาที่ถูกคืนเครื่อง "ทีหลัง" (ตอน apply เดิมสัญญายังไม่คืนเครื่อง ใบเสร็จเห็นได้ปกติ) หายไปจาก
--      feed ทุกใบ — ทั้งที่ใบเสร็จนั้นไม่ได้ถูกลบ/แก้จริงเลย (แค่ PJ ซ่อนเพราะสถานะ invoice เปลี่ยน) → ระบบ
--      จะยิง RECEIPT_MISSING ผิดๆ เข้ากล่องรอตรวจซ้ำๆ ทุกชั่วโมง (ยังไม่มีแถวผิดค้างตอนนี้ — เช็คแล้ว
--      23 ก.ค. 2026 — แต่พร้อมระเบิดทันทีที่สัญญาไหนถูกคืนเครื่องหลัง apply ใบเสร็จไปแล้ว)
--   2) pj-sync (ทุก mode เดิม — sync ทุก 15 นาที + reconcile ทุกชั่วโมง) ตาบอดกับสัญญากลุ่มนี้ 100% —
--      เงินที่ลูกค้าจ่ายหลังคืนเครื่องแล้ว (ยังมีงวดค้าง/ค่าปรับค้าง) จะไม่ถูกเห็นเลย ไม่มีทางรู้จากใบเสร็จ
--      feed ปกติ ต้องเปิด invoice detail page (server-rendered HTML) ทีละใบเทียบยอดเอาเอง
--
-- SECTION 1 แก้ปัญหาข้อ 1 (อุด false-positive) — additive: create or replace function เดิม signature เป๊ะ
-- SECTION 2 เตรียมทางให้ Edge Function (supabase/functions/pj-sync/index.ts) เพิ่ม mode="returned_watch"
--           เขียนแยกไฟล์ Edge Function เอง (Deno, ไม่ใช่ migration) — ที่นี่แค่ขยาย CHECK constraint ให้
--           pj_sync_runs.run_kind รับค่าใหม่ได้ (เดิมมีแค่ 'sync'/'reconcile' จาก 0114)
--
-- ห้ามแก้ 0114 ย้อนหลัง (additive only ตามกฎโปรเจกต์) — ไฟล์นี้ create or replace ทับ logic เดิม (Postgres
-- ผูก signature เดิมเป๊ะ ไม่ใช่ overload ใหม่ เพราะ arg-list ไม่เปลี่ยนสักตัว — ต่างจากกรณี 0100 ที่ต้อง
-- DROP ก่อนเพราะเพิ่ม parameter ใหม่)

-- ============================================================================
-- SECTION 1: pj_sync_runs.run_kind — เพิ่ม 'returned_watch' เข้า CHECK constraint (เดิม 0114 มีแค่
-- 'sync'/'reconcile') ให้ Edge Function insert run_kind='returned_watch' ได้โดยไม่ชน constraint
-- ============================================================================

alter table public.pj_sync_runs
  drop constraint if exists pj_sync_runs_run_kind_check;
alter table public.pj_sync_runs
  add constraint pj_sync_runs_run_kind_check
  check (run_kind in ('sync', 'reconcile', 'returned_watch'));

comment on column public.pj_sync_runs.run_kind is '0114/0125 — sync (default, ทุก 15 นาที ดึงเงินเข้า/ลงงวด) | reconcile (ทุกชั่วโมง ตรวจใบเสร็จหาย/ถูกแก้ ไม่แตะเงิน) | returned_watch (รายวัน ตรวจเงินคืนเครื่องที่ PJ ซ่อนใบเสร็จ — ไม่แตะเงิน queue กล่องรอตรวจอย่างเดียว)';

-- ============================================================================
-- SECTION 2: pj_sync_review.reason — ขยาย comment ให้รู้จักค่าใหม่ 'RETURNED_CONTRACT_PAYMENT' (mode
-- returned_watch) — คอลัมน์เดิมเป็น `text not null` ไม่มี CHECK constraint บังคับค่า (ดู 0077) จึงไม่ต้อง
-- alter constraint ใดๆ แค่เอกสารกำกับให้ครบ (คนอ่าน migration ย้อนหลังจะได้รู้ที่มา)
-- ============================================================================

comment on column public.pj_sync_review.reason is 'MULTI/PARTIAL/UNMATCHED/OTHER/AMOUNT_MISMATCH (0077) | RECEIPT_MISSING/RECEIPT_CHANGED (0114, drift) | RETURNED_CONTRACT_PAYMENT (0125, mode returned_watch, diff>0 — เงินจ่ายหลังคืนเครื่องที่ PJ ซ่อนใบเสร็จ ห้าม auto-apply เด็ดขาด รอ admin ตัดสินใจ) | RETURNED_CONTRACT_OVERAGE (0125, mode returned_watch, diff<0 — เราบันทึกยอดเกิน PJ บนสัญญาคืนเครื่อง; แยกจาก AMOUNT_MISMATCH โดยเจตนา เพราะ AMOUNT_MISMATCH ทำให้หน้า /pj-sync-review เปิด ApplyPjModal ให้กดลงเงินได้ — reason ใหม่นี้ไม่มี guard ให้กดลงเงินเลย ป้องกันคนใส่เงินเข้าสัญญาคืนเครื่องจาก diff สังเคราะห์)';

-- ============================================================================
-- SECTION 3: reconcile_pj_receipts — create or replace ทับของเดิม (0114) เพิ่ม exclude สัญญา
-- status in ('returned', 'returned_closed') ออกจากทั้ง v_our_evaluable (denominator) และ loop ประเมิน
-- missing/changed — join ผ่าน pj_applied_receipts.contract_id → contracts.id (0100)
--
-- ทำไม exclude ทั้ง 2 จุด (ไม่ใช่แค่ loop): v_our_evaluable ใช้เทียบ ratio sanity check
-- (evaluateRunSanity — v_prev_run_count * 0.5) ถ้าไม่ตัดออกจาก denominator ด้วย ตัวเลข ourEvaluableCount
-- จะนับรวมใบที่ไม่ถูกประเมินจริง ทำให้ ratio เพี้ยนได้ (นับรวมแต่ไม่ได้ประเมิน = mismatch ระหว่าง
-- ourEvaluableCount กับ evaluated count ที่ควรเท่ากันเสมอตามที่ RPC เดิมออกแบบไว้)
--
-- left join (ไม่ inner join) + เงื่อนไข `c.status is null or c.status not in (...)` — defensive กันเคส
-- contract_id เป็น null (ไม่ควรเกิดจริง เพราะ record_payment_spread ต้องมี p_contract_id เสมอ ไม่มี
-- default — แต่กันไว้ไม่ให้ null ถูกตัดออกผิดจุดถ้ามีข้อมูลเก่าแปลกๆ หลุดมา)
-- ============================================================================

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
        elsif lower(trim(coalesce(rec.payment_type, ''))) <> lower(trim(coalesce(v_pj_type, ''))) then
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
  'ตรวจจับใบเสร็จ PJ ที่หาย/ถูกแก้ (0114) — diff pj_applied_receipts กับ snapshot PJ ที่ Edge Function ส่งมา, update missing_streak/last_seen_in_pj_at/drift_reported_at + insert pj_sync_review (reason RECEIPT_MISSING/RECEIPT_CHANGED) แบบ atomic; p_dry_run=true = คำนวณอย่างเดียวไม่เขียนอะไร; ตรวจ+รายงานเท่านั้น ไม่แตะเงิน/installments เลย (Pete locked); 0125 — exclude สัญญา status returned/returned_closed ออกจากการประเมิน (PJ ซ่อนใบเสร็จของสัญญากลุ่มนี้ทั้งหมดจาก feed โดยไม่เกี่ยวกับใบถูกลบ/แก้จริง — ดู mode returned_watch ใน pj-sync/index.ts สำหรับการตรวจเงินคืนเครื่องแทน)';

-- signature เดิมเป๊ะ (jsonb, date, date, timestamptz, boolean) — CREATE OR REPLACE ทับของเดิมจริง ไม่ใช่
-- overload ใหม่ → grant execute เดิม (service_role, จาก 0114) ยังอยู่ครบ ไม่ต้อง grant ซ้ำ

-- ============================================================================
-- SECTION 4: returned_watch_our_paid — เพิ่มหลังติ๊กรีวิว returned_watch (RED 2, 23 ก.ค. 2026): ยอด
-- ฝั่งเรา (เงินต้น+ค่าปรับ) ต่อสัญญา สำหรับ mode "returned_watch" ใน Edge Function (pj-sync/index.ts)
--
-- ทำไมต้องมีตัวนี้ — ห้าม sum(payment_log.penalty_paid_amount where action='pay') ตรงๆ:
--   cancel_payment (0011) insert แถว action='cancel' เพื่อ "รีเซ็ตยอด" แต่ไม่ negate/ลบแถว 'pay' เก่าที่
--   เคยลงไปก่อนหน้าเลย (ดู 0011_payment_audit.sql) → sum ตรงๆ นับแถว pay เก่าที่ถูกยกเลิกไปแล้วซ้ำ → ยอด
--   เราเฟ้อกว่าความจริง → diff (pjPaidTotal - ourPaidTotal) หดตัวลงหรือกลับด้าน → พลาดไม่เห็นเงินที่หายจริง
--   (false negative) ระบบมี helper ที่คิดถูกอยู่แล้ว: public.penalty_paid_for_installment(uuid) (0115 —
--   เรียง payment_log ตาม created_at, cancel ล่าสุด = จุดตัด, sum เฉพาะแถว pay หลังจุดตัดนั้น)
--
-- ทำไมห่อเป็นฟังก์ชันใหม่แทนเรียก penalty_paid_for_installment ตรงๆ จาก Edge Function — helper เดิมรับ
-- แค่ 1 installment_id ต่อครั้ง ถ้า Edge Function เรียกทีละงวด (93 สัญญา × N งวด) จะกลายเป็น N+1 RPC
-- round-trip หนักมาก (เครือข่ายจริง ไม่ใช่แค่ query ภายใน Postgres) จึงห่อ set-based ให้รับ contract_ids[]
-- คืนยอดรวมต่อสัญญาในคำสั่งเดียว — ภายในยังเรียก penalty_paid_for_installment ต่องวดอยู่ (correlated
-- subquery ธรรมดาในแผน query เดียวของ Postgres ไม่ใช่ RPC ข้ามเครือข่ายซ้ำ) Edge Function ยิงแค่ 1 ครั้ง
-- รวมทุกสัญญาที่ต้องตรวจรอบนั้น (ไม่ใช่ทีละสัญญา/ทีละงวด)
-- ============================================================================

create or replace function public.returned_watch_our_paid(p_contract_ids uuid[])
returns table(contract_id uuid, inst_paid numeric, pen_paid numeric)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    i.contract_id,
    coalesce(sum(i.paid_amount), 0)::numeric as inst_paid,
    coalesce(sum(public.penalty_paid_for_installment(i.id)), 0)::numeric as pen_paid
  from public.installments i
  where i.contract_id = any(p_contract_ids)
  group by i.contract_id;
$$;

grant execute on function public.returned_watch_our_paid(uuid[])
  to authenticated, service_role;

comment on function public.returned_watch_our_paid(uuid[]) is
  '(0125) ยอดฝั่งเรารวมต่อสัญญา (เงินต้น sum(installments.paid_amount) ทุกงวด + ค่าปรับ cancel-aware sum(penalty_paid_for_installment(id)) ต่องวด) — ใช้โดย pj-sync mode=returned_watch แทนการ sum(payment_log.penalty_paid_amount) ตรงๆ ที่เฟ้อเพราะ cancel_payment (0011) ไม่ negate แถว pay เก่า; รับ contract_ids[] คืนหลายแถวในคำสั่งเดียว กัน N+1 RPC จาก Edge Function';

-- ============================================================================
-- SECTION 5: Verify (ครีมรันหลัง apply ผ่าน MCP)
-- ============================================================================

-- 5a) run_kind constraint ใหม่รับ 'returned_watch':
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conname = 'pj_sync_runs_run_kind_check';
-- -- expected: CHECK (run_kind = ANY (ARRAY['sync'::text, 'reconcile'::text, 'returned_watch'::text]))

-- 5b) signature ยังเป็นตัวเดียว (ไม่มี overload ใหม่โผล่มา):
-- select p.pronargs, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p where p.proname='reconcile_pj_receipts' and p.pronamespace='public'::regnamespace;
-- -- expected: 1 แถว (jsonb, date, date, timestamptz, boolean)

-- 5c) service_role ยังเรียก reconcile_pj_receipts ได้ (grant เดิมไม่หาย):
-- select has_function_privilege('service_role', 'public.reconcile_pj_receipts(jsonb,date,date,timestamptz,boolean)', 'execute'); -- ต้อง true

-- 5d) smoke: สัญญา returned/returned_closed ที่มี pj_applied_receipts ไม่ถูกนับใน ourEvaluableCount อีกต่อไป
-- (ต้องเทียบก่อน/หลัง apply ด้วยตัวเลขจริงจากฐาน — ตัวอย่าง query หาสัญญาทดสอบ):
-- select r.pj_receipt_uuid, c.status
--   from public.pj_applied_receipts r join public.contracts c on c.id = r.contract_id
--  where c.status in ('returned','returned_closed') and r.pj_paid_date >= '2026-07-13'
--  limit 5;
-- -- ถ้ามีแถว → เรียก reconcile_pj_receipts(dry_run=true) ด้วย window ครอบวันนั้น ต้องไม่เห็น uuid พวกนี้ใน details เลย

-- 5e) has_table_privilege เดิมของ pj_sync_runs/pj_sync_review/pj_applied_receipts ไม่เปลี่ยน (0017/0077/0100
-- ให้ไว้ครบแล้ว) — ไม่ต้อง grant เพิ่มในไฟล์นี้

-- 5f) service_role เรียก returned_watch_our_paid ได้ (grant ใหม่ SECTION 4):
-- select has_function_privilege('service_role', 'public.returned_watch_our_paid(uuid[])', 'execute'); -- ต้อง true

-- 5g) sanity เทียบ returned_watch_our_paid กับ sum ตรงๆ ของ payment_log (RED2 fix) — ต้องเลือกสัญญาที่เคย
-- cancel_payment แล้วจ่ายใหม่มาลองเทียบ ตัวเลขจาก RPC ต้อง <= sum ตรงๆ เสมอ (ตรงกันถ้าไม่เคย cancel เลย):
-- select
--   rw.contract_id, rw.pen_paid as via_helper,
--   (select coalesce(sum(pl.penalty_paid_amount), 0) from public.payment_log pl
--     where pl.contract_id = rw.contract_id and pl.action = 'pay') as via_naive_sum
-- from public.returned_watch_our_paid(array['<contract_id>'::uuid]) rw;
-- -- expected: via_helper <= via_naive_sum เสมอ; ต่างกันชัดเจนถ้าสัญญานั้นเคย cancel_payment มาก่อน
