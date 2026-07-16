-- 0114: ตรวจจับ "ใบเสร็จ PJ ที่หาย/ถูกแก้" (reconcile) — ตรวจ+รายงานเท่านั้น ห้ามถอนเงิน/แก้ยอดอัตโนมัติ
--
-- บั๊กต้นเรื่อง (16 ก.ค. 2026): pj-sync ดึงเงิน "เข้า" อย่างเดียว ไม่เคยย้อนถามว่าใบที่เคยดึงมา ยังอยู่ใน
-- PJ ไหม — ร้านลบ/แก้ใบใน PJ ภายหลัง → เว็บเรากอดใบผีไว้ (เงินเฟ้อ/ลงผิดงวด) กวาดมือเจอ 5 ใบ 6,979 บาท
-- (ลบใบ / เปลี่ยนประเภท installment→other / เปลี่ยนวันที่) ดูรายละเอียด logic เต็มที่
-- src/lib/pjReceiptDrift.ts (evaluateReceiptDrift/evaluateRunSanity — แบมเขียน, pure fn, ห้ามแก้)
--
-- Pete locked: ตรวจ+รายงานเท่านั้น → เด้งเข้า pj_sync_review (reuse ตารางเดิม ไม่สร้างใหม่) ไม่มีปุ่มถอนเงิน
-- เฟสนี้ (เรียกครีมแก้มือ) — cron ทุกชั่วโมง (ครีมสร้างเองทีหลัง หลัง dryRun กับ Pete)
--
-- additive ล้วน: add column if not exists (nullable/default constant เท่านั้น — ไม่ rewrite ตาราง,
-- verify ด้านล่าง), create index/function if not exists/or replace — ไม่กระทบ jobid 6 (ทุก 15 นาที)
-- ที่ยัง insert ลง pj_applied_receipts ปกติ (คอลัมน์ใหม่ทั้งหมดมี default/nullable ไม่ต้องส่งค่า)

-- ============================================================================
-- SECTION 1: pj_applied_receipts — คอลัมน์ track สถานะ "เห็นล่าสุดใน PJ เมื่อไหร่ / หายกี่รอบติด / เคย
-- ถูกรายงานหรือยัง" ต่อใบเสร็จ (ตารางเดิม migration 0100 — ตารางเล็ก ไม่มี RLS ตั้งใจ)
-- ============================================================================

alter table public.pj_applied_receipts
  add column if not exists last_seen_in_pj_at timestamptz,        -- ครั้งล่าสุดที่ reconcile เจอ uuid นี้ใน snapshot PJ (null = ไม่เคยถูก reconcile evaluate หรือหายตั้งแต่ครั้งแรก)
  add column if not exists missing_streak     int not null default 0,  -- จำนวนรอบ reconcile ติดกันที่หา uuid นี้ไม่เจอใน PJ แล้ว (>=2 ถึงจะรายงาน — ดู MISSING_STREAK_THRESHOLD ใน pjReceiptDrift.ts)
  add column if not exists drift_reported_at  timestamptz,         -- ครั้งแรกที่ uuid นี้ถูกรายงานเข้ากล่องรอตรวจ (ตั้งครั้งเดียว ไม่ overwrite — coalesce ใน RPC ด้านล่าง)
  add column if not exists drift_kind         text;                -- 'missing'|'amount'|'type'|'date' ครั้งแรกที่รายงาน (เก็บไว้ debug/audit — ไม่ overwrite เหมือนกัน)

alter table public.pj_applied_receipts
  drop constraint if exists pj_applied_receipts_drift_kind_check;
alter table public.pj_applied_receipts
  add constraint pj_applied_receipts_drift_kind_check
  check (drift_kind is null or drift_kind in ('missing', 'amount', 'type', 'date'));

comment on column public.pj_applied_receipts.last_seen_in_pj_at is 'reconcile (0114) — ครั้งล่าสุดที่ตรวจเจอ uuid นี้ยังอยู่ใน PJ; null = ยังไม่เคย evaluate หรือหายตั้งแต่ evaluate ครั้งแรก';
comment on column public.pj_applied_receipts.missing_streak is 'reconcile (0114) — จำนวนรอบติดกันที่หา uuid ไม่เจอใน PJ; รีเซ็ตเป็น 0 ทันทีที่เจอ; >=2 ถึงรายงาน (กัน false-positive รอบแรกที่ PJ อาจตอบไม่ครบชั่วคราว)';
comment on column public.pj_applied_receipts.drift_reported_at is 'reconcile (0114) — ตั้งครั้งแรกที่รายงานเท่านั้น (coalesce กันถูก overwrite) ใช้คู่กับ pj_sync_review.pj_receipt_uuid unique index เป็น idempotency ถาวร';
comment on column public.pj_applied_receipts.drift_kind is 'reconcile (0114) — kind ครั้งแรกที่รายงาน missing|amount|type|date (ดู src/lib/pjReceiptDrift.ts DriftKind)';

-- ⚠️ verify ก่อนปล่อยให้ cron ทุก 15 นาที (jobid 6) วิ่งต่อ — คอลัมน์ใหม่ทั้งหมด nullable หรือ default
-- constant (0) ล้วน → ADD COLUMN เป็น metadata-only ใน Postgres 11+ (ไม่รีไรท์ตาราง ไม่ lock นาน) และ
-- record_payment_spread (0100 SECTION 2) ที่ insert เข้าตารางนี้ไม่ระบุคอลัมน์ใหม่พวกนี้เลย → ใช้ default
-- อัตโนมัติ ไม่ต้องแก้ RPC เดิม ไม่กระทบ path เงินเข้าเลย:
-- select column_name, is_nullable, column_default from information_schema.columns
--  where table_schema='public' and table_name='pj_applied_receipts'
--    and column_name in ('last_seen_in_pj_at','missing_streak','drift_reported_at','drift_kind');

-- ============================================================================
-- SECTION 2: pj_sync_review — เพิ่ม pj_receipt_uuid (คีย์อ้างอิงใบเสร็จที่ drift) + partial unique index
-- กันแจ้งซ้ำ "ถาวร" (ผีถูกแจ้งครั้งเดียวตลอดกาล แม้ resolve/skip ไปแล้ว — ไม่ใช่แค่กันซ้ำตอน status=pending)
-- ============================================================================

alter table public.pj_sync_review
  add column if not exists pj_receipt_uuid text;  -- uuid ดิบจาก PJ (ตรงกับ pj_applied_receipts.pj_receipt_uuid) — เฉพาะแถว reason=RECEIPT_MISSING/RECEIPT_CHANGED เท่านั้นที่ตั้งค่านี้

comment on column public.pj_sync_review.pj_receipt_uuid is 'เฉพาะแถว drift (RECEIPT_MISSING/RECEIPT_CHANGED, migration 0114) — uuid ใบเสร็จจาก PJ ที่ตรวจเจอว่าหาย/ถูกแก้ ใช้เป็น idempotency key (unique partial index ด้านล่าง) ไม่ใช่ dedup key ของแถวปกติ (MULTI/PARTIAL/UNMATCHED/OTHER/AMOUNT_MISMATCH ยังคง null ต่อไป)';

-- partial unique index: 1 uuid รายงาน "drift" ได้แค่ 1 แถวตลอดกาล (แม้ resolve ไปแล้ว uuid เดิมกลับมา
-- "หาย" อีกก็ไม่แจ้งซ้ำ — INSERT ... ON CONFLICT (pj_receipt_uuid) WHERE reason IN (...) DO NOTHING ใน RPC ด้านล่าง)
drop index if exists public.pj_sync_review_drift_uuid_uidx;
create unique index pj_sync_review_drift_uuid_uidx
  on public.pj_sync_review (pj_receipt_uuid)
  where reason in ('RECEIPT_MISSING', 'RECEIPT_CHANGED');

-- ============================================================================
-- SECTION 3: pj_sync_runs — แยก run_kind (sync ทุก 15 นาที ดึงเงินเข้า / reconcile ทุกชั่วโมง ตรวจใบผี)
-- ============================================================================

alter table public.pj_sync_runs
  add column if not exists run_kind text not null default 'sync';

alter table public.pj_sync_runs
  drop constraint if exists pj_sync_runs_run_kind_check;
alter table public.pj_sync_runs
  add constraint pj_sync_runs_run_kind_check
  check (run_kind in ('sync', 'reconcile'));

comment on column public.pj_sync_runs.run_kind is '0114 — sync (default, ทุก 15 นาที ดึงเงินเข้า/ลงงวด) | reconcile (ทุกชั่วโมง ตรวจใบเสร็จหาย/ถูกแก้ ไม่แตะเงิน)';

-- ============================================================================
-- SECTION 4: RPC reconcile_pj_receipts — diff snapshot PJ กับ pj_applied_receipts ของเรา + เขียน state
-- + insert pj_sync_review แบบ atomic ในทรานแซกชันเดียว (dry_run=true = คำนวณอย่างเดียว ไม่เขียนอะไรเลย)
--
-- ⚠️ logic ต้องตรงกับ src/lib/pjReceiptDrift.ts (evaluateReceiptDrift + evaluateRunSanity) เป๊ะ — ก็อปปี้
-- ค่าคงที่มาตรงตัว (comment กำกับทุกจุดว่าอ้างอิงจากตัวแปรไหนในไฟล์นั้น) ถ้าค่าคงที่ฝั่ง TS เปลี่ยน ต้องแก้
-- migration ใหม่ตามด้วย (ห้ามแก้ 0114 ย้อนหลัง — additive only ตามกฎโปรเจกต์):
--   COVERAGE_FLOOR_ISO   = '2026-07-13T00:00:00.000Z'
--   SETTLE_MARGIN_MS     = 30*60*1000  (30 นาที)
--   MISSING_STREAK_THRESHOLD = 2
--   RUN_SANITY_MIN_RATIO = 0.5
--
-- ไม่แตะ pj_sync_runs เลย (ไม่ insert/update) — Edge Function (supabase/functions/pj-sync/index.ts)
-- เป็นคนจัดการ lock+insert 'running' row + finalize เอง (reuse โค้ด mutex เดิมของ mode sync ทุกอย่าง
-- แค่ tag run_kind='reconcile') RPC นี้อ่าน pj_sync_runs แค่ read-only (หา previous successful run
-- สำหรับ ratio sanity check) — แยกความรับผิดชอบชัดเจน: RPC = diff เงิน/ใบเสร็จ, Edge Function JS = bookkeeping
--
-- p_snapshot: jsonb ObjectShape { "rows": [{uuid, amount, payment_type, paid_date:'YYYY-MM-DD'}, ...],
--   "truncated": boolean } — "rows" ต้องมีทุกแถวที่ PJ ตอบกลับมาในช่วง window รวม type "down" ด้วย
--   (ห้าม Edge Function กรอง down ทิ้งก่อนส่งมา — ใบที่ประเภทเปลี่ยนเป็น down จะดูเหมือน 'missing' ผิดๆ
--   ถ้าไม่ส่งมาเทียบ) เผื่อ backward-compat รับ jsonb array ตรงๆ ได้ด้วย (ไม่มี "rows" wrapper)
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
  select count(*) into v_our_evaluable
    from public.pj_applied_receipts r
   where r.pj_paid_date is not null
     and r.pj_paid_date between p_window_start and p_window_end
     and r.applied_at >= '2026-07-13T00:00:00.000Z'::timestamptz          -- COVERAGE_FLOOR_ISO
     and p_snapshot_at - r.applied_at >= interval '30 minutes';           -- SETTLE_MARGIN_MS

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

  -- ── loop ใบเสร็จของเราที่ "evaluable" รอบนี้ (ผ่านทั้ง 3 เกต เหมือน v_our_evaluable ด้านบน) ──────────
  for rec in
    select r.pj_receipt_uuid, r.amount, r.payment_type, r.pj_paid_date, r.applied_at,
           r.missing_streak, r.contract_id, r.pj_invoice_no
      from public.pj_applied_receipts r
     where r.pj_paid_date is not null
       and r.pj_paid_date between p_window_start and p_window_end
       and r.applied_at >= '2026-07-13T00:00:00.000Z'::timestamptz
       and p_snapshot_at - r.applied_at >= interval '30 minutes'
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
  'ตรวจจับใบเสร็จ PJ ที่หาย/ถูกแก้ (0114) — diff pj_applied_receipts กับ snapshot PJ ที่ Edge Function ส่งมา, update missing_streak/last_seen_in_pj_at/drift_reported_at + insert pj_sync_review (reason RECEIPT_MISSING/RECEIPT_CHANGED) แบบ atomic; p_dry_run=true = คำนวณอย่างเดียวไม่เขียนอะไร; ตรวจ+รายงานเท่านั้น ไม่แตะเงิน/installments เลย (Pete locked)';

-- เฉพาะ service_role (Edge Function pj-sync mode=reconcile) เรียก — ไม่มี caller อื่นจาก UI/authenticated
grant execute on function public.reconcile_pj_receipts(jsonb, date, date, timestamptz, boolean) to service_role;

-- ============================================================================
-- SECTION 5: GRANTs — ตาราง public.* เดิม (pj_applied_receipts/pj_sync_review/pj_sync_runs) มี
-- SELECT/INSERT/UPDATE/DELETE ให้ service_role อยู่แล้วจาก 0017 (default privileges, table-level ครอบ
-- คอลัมน์ใหม่อัตโนมัติ ไม่ต้อง grant ซ้ำ) — ต้อง grant เฉพาะ "ฟังก์ชันใหม่" เท่านั้น (ทำไปแล้วด้านบน)
-- ไม่มี GRANT เพิ่มสำหรับ authenticated: reconcile_pj_receipts ไม่มี UI caller (เฟสนี้ตรวจ+รายงานอย่างเดียว)
-- ============================================================================

-- ============================================================================
-- SECTION 6: Verify (ครีมรันหลัง apply ผ่าน MCP — comment ไว้ ไม่รันอัตโนมัติ)
-- ============================================================================

-- 6a) คอลัมน์ใหม่ครบ:
-- select column_name, data_type, column_default from information_schema.columns
--  where table_schema='public' and table_name='pj_applied_receipts'
--    and column_name in ('last_seen_in_pj_at','missing_streak','drift_reported_at','drift_kind');
-- select column_name, data_type from information_schema.columns
--  where table_schema='public' and table_name='pj_sync_review' and column_name='pj_receipt_uuid';
-- select column_name, data_type, column_default from information_schema.columns
--  where table_schema='public' and table_name='pj_sync_runs' and column_name='run_kind';

-- 6b) partial unique index มีจริง + predicate ถูกต้อง:
-- select indexname, indexdef from pg_indexes where indexname='pj_sync_review_drift_uuid_uidx';

-- 6c) service_role มีสิทธิ์ครบบนตารางเดิม (ควร true อยู่แล้วจาก 0017 — เช็คซ้ำให้ชัวร์):
-- select has_table_privilege('service_role', 'public.pj_applied_receipts', 'UPDATE');  -- true
-- select has_table_privilege('service_role', 'public.pj_sync_review', 'INSERT');       -- true
-- select has_function_privilege('service_role', 'public.reconcile_pj_receipts(jsonb,date,date,timestamptz,boolean)', 'execute'); -- true

-- 6d) RPC signature เดียว ไม่มีตัวซ้ำ:
-- select p.pronargs, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p where p.proname='reconcile_pj_receipts' and p.pronamespace='public'::regnamespace;
-- expected: 1 แถว (jsonb, date, date, timestamptz, boolean)

-- 6e) dry-run smoke (ไม่เขียนอะไร) — เรียกด้วย snapshot ว่าง window แคบ ต้องได้ ok=true/false ตามข้อมูลจริง:
-- select public.reconcile_pj_receipts(
--   '{"rows": [], "truncated": false}'::jsonb, '2026-07-13'::date, '2026-07-16'::date, now(), true
-- );

-- 6f) idempotency: insert ซ้ำ uuid เดิม reason drift ต้องไม่เพิ่มแถวใหม่ (ON CONFLICT DO NOTHING ทำงาน):
-- select pj_receipt_uuid, count(*) from public.pj_sync_review
--  where reason in ('RECEIPT_MISSING','RECEIPT_CHANGED') group by pj_receipt_uuid having count(*) > 1;
-- expected: 0 แถว (ไม่มี uuid ไหนถูกรายงานซ้ำ)
