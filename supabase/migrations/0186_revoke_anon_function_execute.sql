-- 0186: ปิดสิทธิ์คนไม่ล็อกอิน (anon/PUBLIC) บนฟังก์ชัน DB ที่แก้ข้อมูลได้ + กันบัญชี freelancer/ปิดใช้งาน เรียกฟังก์ชันลงเงิน
-- Additive: create or replace (4 ฟังก์ชันที่เว็บเรียก เติมเช็ค admin/staff active) + revoke/grant explicit ไม่แตะข้อมูล/ตาราง
--
-- ที่มา: ฟังก์ชัน security definer ใน public ได้ EXECUTE ให้ PUBLIC (anon เป็นสมาชิก) โดย default -> ใครก็เรียกผ่าน /rest/v1/rpc ได้โดยไม่ล็อกอิน
-- การจัดกลุ่ม (ตรวจผู้เรียกจริงจาก src/lib/db.ts, supabase/functions/*, pg_cron, trigger, RPC ซ้อน):
--   G1 service_role เท่านั้น  : autoclose_contract_if_fully_paid, reconcile_pj_receipts, record_payment_spread, run_daily_update
--        (เว็บไม่เรียก; pj-sync ใช้ service_role; cron 'winsure-daily' รันเป็น postgres (owner); RPC ซ้อนจาก apply_pj_review_payment เป็น definer ไม่ต้องใช้ EXECUTE ของผู้เรียก)
--   G2 trigger function ทุกตัวใน public (returns trigger): ถอนจากทุก role (Postgres เช็ค EXECUTE ตอน CREATE TRIGGER เท่านั้น ไม่เช็คตอน fire)
--   G3 authenticated + service_role: ฟังก์ชันที่เว็บเรียกจริง (มีเช็ค auth ในตัวอยู่แล้ว หรือเติมเช็คในไฟล์นี้)
--   G3 รอบ 2: ฟังก์ชันอ่าน/คำนวณ 21 ตัว (get_collector_*, get_freelancer_*, media_*, penalty_*_for_installment, mark_*, ...) ปิด anon คง authenticated
--   ไม่แตะ (ตั้งใจ): freelancer_has_grade (ตัวช่วย RLS), contract_media_safe_contract_id, contracts_generated_columns (คำนวณล้วน ไม่มีข้อมูล), exam_event/exam_save/exam_start/exam_submit (ระบบข้อสอบ ไม่มีในรีโป รอตรวจว่าตั้งใจเปิดให้ anon)
-- ฟังก์ชันที่ไม่พบใน DB จะถูกข้าม (ปลอดภัยต่อ environment ที่ไม่มีครบ)

-- record_payment_with_penalty: เนื้อเดิมจาก 0185_payment_contract_lock.sql + เพิ่มเช็คสิทธิ์ต้นฟังก์ชัน (ที่เหลือเหมือนเดิม; regen_installments รวมแพตช์ reversed_at is null จาก 0171)
create or replace function public.record_payment_with_penalty(
  p_installment_id      uuid,
  p_paid_amount         numeric,          -- principal เท่านั้น
  p_paid_at             timestamptz,      -- เวลาชำระ (ส่งจาก client ตอนกดยืนยัน)
  p_by_name             text,
  p_penalty_paid_amount numeric default 0 -- ค่าปรับที่ชำระ (default 0 = ไม่มีค่าปรับ)
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_contract_id         uuid;
  v_installment_amount  numeric;
  v_prev_paid           numeric;
  v_new_principal_total numeric;
  v_total_received      numeric;
  v_fully_paid          boolean;
begin
  -- (0186) สิทธิ์: ต้องเป็น admin หรือ staff ที่ active (เหมือน apply_pj_review_payment)
  -- auth.uid() ว่าง = service_role/postgres เท่านั้น (anon/PUBLIC ถูกถอน EXECUTE ในไฟล์นี้แล้ว)
  if auth.uid() is not null and not exists (
       select 1 from public.profiles
        where id = auth.uid() and role in ('admin', 'staff') and active = true) then
    raise exception 'FORBIDDEN: ต้องเป็น admin หรือ staff ที่ยัง active' using errcode = '42501';
  end if;
  -- (0185) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread
  select contract_id into v_contract_id from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_contract_id for update;
  end if;

  -- ล็อก row เพื่อกัน concurrent payment บนงวดเดียวกัน
  select contract_id, amount, coalesce(paid_amount, 0)
    into v_contract_id, v_installment_amount, v_prev_paid
    from public.installments
   where id = p_installment_id
     for update;

  if not found then
    raise exception 'installment % not found', p_installment_id;
  end if;

  -- paid_amount สะสมเฉพาะ principal (สอดคล้องกับ outstanding formula)
  v_new_principal_total := v_prev_paid + p_paid_amount;
  -- amount ใน payment_log = ยอดรับจริง (principal + penalty)
  v_total_received      := p_paid_amount + p_penalty_paid_amount;
  -- ปิดงวดเมื่อ principal สะสม >= ค่างวด (ตรงกับ record_payment RPC ใน 0011)
  v_fully_paid          := v_new_principal_total >= v_installment_amount
                           and v_installment_amount > 0;

  -- INSERT payment_log ก่อน — trigger set_payment_log_actor + trg_clear_promise_on_pay จะ fire
  insert into public.payment_log (
    installment_id,
    contract_id,
    action,
    amount,               -- ยอดรับจริง (principal + penalty)
    paid_amount_after,    -- principal สะสม หลังทำรายการ
    penalty_paid_amount,
    by_name
  ) values (
    p_installment_id,
    v_contract_id,
    'pay',
    v_total_received,
    v_new_principal_total,
    p_penalty_paid_amount,
    p_by_name
  );

  -- UPDATE installments — paid_amount สะสม principal เท่านั้น
  if v_fully_paid then
    update public.installments
       set paid_amount   = v_new_principal_total,
           paid_at       = p_paid_at,
           status        = 'paid',
           paid_by_name  = p_by_name
     where id = p_installment_id;
  else
    update public.installments
       set paid_amount   = v_new_principal_total,
           paid_at       = null,
           status        = case when due_date < current_date then 'late' else 'pending' end,
           paid_by_name  = null
     where id = p_installment_id;
  end if;

end;
$$;

-- record_penalty_only_payment: เนื้อเดิมจาก 0185_payment_contract_lock.sql + เพิ่มเช็คสิทธิ์ต้นฟังก์ชัน (ที่เหลือเหมือนเดิม; regen_installments รวมแพตช์ reversed_at is null จาก 0171)
create or replace function public.record_penalty_only_payment(
  p_installment_id uuid,
  p_penalty        numeric,
  p_by_name        text,
  p_paid_at        timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_contract_id      uuid;
  v_penalty_amount   numeric;
  v_paid_amount      numeric;
  v_already_paid     numeric;
  v_remaining        numeric;
begin
  -- (0186) สิทธิ์: ต้องเป็น admin หรือ staff ที่ active (เหมือน apply_pj_review_payment)
  -- auth.uid() ว่าง = service_role/postgres เท่านั้น (anon/PUBLIC ถูกถอน EXECUTE ในไฟล์นี้แล้ว)
  if auth.uid() is not null and not exists (
       select 1 from public.profiles
        where id = auth.uid() and role in ('admin', 'staff') and active = true) then
    raise exception 'FORBIDDEN: ต้องเป็น admin หรือ staff ที่ยัง active' using errcode = '42501';
  end if;
  -- guard: ค่าปรับต้อง > 0 เท่านั้น (ปุ่มนี้ทำหน้าที่เดียว เก็บค่าปรับ ห้ามเรียกด้วย 0/ติดลบ)
  if p_penalty is null or p_penalty <= 0 then
    raise exception 'ยอดค่าปรับต้องมากกว่า 0 บาท: %', p_penalty;
  end if;

  -- (0185) เข้าคิวรายสัญญาก่อนล็อกงวด (สัญญา -> งวด) ลำดับเดียวกับ record_payment_spread
  select contract_id into v_contract_id from public.installments where id = p_installment_id;
  if found then
    perform 1 from public.contracts where id = v_contract_id for update;
  end if;

  -- ล็อกแถวงวดกัน concurrent เก็บซ้ำพร้อมกัน + โหลดค่าที่ต้องใช้
  select contract_id, coalesce(penalty_amount, 0), coalesce(paid_amount, 0)
    into v_contract_id, v_penalty_amount, v_paid_amount
    from public.installments
   where id = p_installment_id
     for update;

  if not found then
    raise exception 'ไม่พบงวดผ่อนนี้: %', p_installment_id;
  end if;

  -- ยอดค่าปรับที่เก็บไปแล้วจริงสะสมของงวดนี้ (mirror calc.ts penaltyPaidForInstallment ผ่าน 0115)
  v_already_paid := public.penalty_paid_for_installment(p_installment_id);
  v_remaining    := v_penalty_amount - v_already_paid;

  -- guard: ห้ามเก็บเกินยอดค่าปรับที่ตั้งไว้ของงวดนั้น
  if p_penalty > v_remaining then
    raise exception 'เก็บค่าปรับเกินยอดที่ค้างจริง (เหลือเก็บได้อีก % บาท)', v_remaining;
  end if;

  -- INSERT payment_log แถวเดียว — ห้ามแตะ installments แม้แต่คอลัมน์เดียว
  -- trigger set_payment_log_actor (BEFORE INSERT) + trg_clear_promise_on_pay (AFTER INSERT) ยังทำงานตามปกติ
  insert into public.payment_log (
    installment_id,
    contract_id,
    action,
    amount,               -- ยอดรับจริง = ค่าปรับล้วน
    paid_amount_after,    -- principal สะสม "ไม่เปลี่ยน" จากเดิม
    penalty_paid_amount,
    by_name
  ) values (
    p_installment_id,
    v_contract_id,
    'pay',
    p_penalty,
    v_paid_amount,
    p_penalty,
    p_by_name
  );

  -- 🔴 เจตนา: ไม่มี UPDATE public.installments ในฟังก์ชันนี้เลย — นี่คือหัวใจของ fix
end;
$$;

-- pj_review_set_penalty: เนื้อเดิมจาก 0117_pj_review_set_penalty.sql + เพิ่มเช็คสิทธิ์ต้นฟังก์ชัน (ที่เหลือเหมือนเดิม; regen_installments รวมแพตช์ reversed_at is null จาก 0171)
create or replace function public.pj_review_set_penalty(
  p_installment_id uuid,
  p_amount         numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_installment installments%rowtype;
  v_per_day     numeric;
begin
  -- (0186) สิทธิ์: ต้องเป็น admin หรือ staff ที่ active (เหมือน apply_pj_review_payment)
  -- auth.uid() ว่าง = service_role/postgres เท่านั้น (anon/PUBLIC ถูกถอน EXECUTE ในไฟล์นี้แล้ว)
  if auth.uid() is not null and not exists (
       select 1 from public.profiles
        where id = auth.uid() and role in ('admin', 'staff') and active = true) then
    raise exception 'FORBIDDEN: ต้องเป็น admin หรือ staff ที่ยัง active' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'ค่าปรับต้องไม่ติดลบ: %', p_amount;
  end if;

  -- ล็อกแถวงวด
  select * into v_installment
    from public.installments
   where id = p_installment_id
   for update;

  if not found then
    raise exception 'ไม่พบงวดผ่อนนี้: %', p_installment_id;
  end if;

  select value::numeric into v_per_day
    from public.app_settings
   where key = 'penalty_per_day';

  if v_per_day is null or v_per_day <= 0 then
    v_per_day := 100; -- fallback กันหาร 0/null ถ้า app_settings ไม่มี key นี้ (ไม่ควรเกิดในทางปฏิบัติ)
  end if;

  update public.installments
     set penalty_amount     = p_amount,
         penalty_days       = round(p_amount / v_per_day)::int,
         penalty_overridden = true
   where id = p_installment_id;
end;
$$;

-- regen_installments: เนื้อเดิมจาก 0063_regen_installments_search_path.sql + เพิ่มเช็คสิทธิ์ต้นฟังก์ชัน (ที่เหลือเหมือนเดิม; regen_installments รวมแพตช์ reversed_at is null จาก 0171)
create or replace function public.regen_installments(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_transaction_date  date;
  v_due_day           int;
  v_term_months       int;
  v_monthly_payment   numeric;
  i                   int;
  v_base              date;
  v_due               date;
begin
  -- (0186) สิทธิ์: ต้องเป็น admin หรือ staff ที่ active (เหมือน apply_pj_review_payment)
  -- auth.uid() ว่าง = service_role/postgres เท่านั้น (anon/PUBLIC ถูกถอน EXECUTE ในไฟล์นี้แล้ว)
  if auth.uid() is not null and not exists (
       select 1 from public.profiles
        where id = auth.uid() and role in ('admin', 'staff') and active = true) then
    raise exception 'FORBIDDEN: ต้องเป็น admin หรือ staff ที่ยัง active' using errcode = '42501';
  end if;
  -- 1. lock แถวสัญญา + อ่านค่าที่ใช้สร้างงวด
  select
    transaction_date,
    due_day,
    term_months,
    monthly_payment
  into
    v_transaction_date,
    v_due_day,
    v_term_months,
    v_monthly_payment
  from contracts
  where id = p_contract_id
  for update;

  if not found then
    raise exception 'contract not found: %', p_contract_id;
  end if;

  -- 2a. guard: ห้าม regen ถ้าเคยขยายระยะเวลา/ปรับโครงสร้างแล้ว
  if exists (
    select 1 from contract_extensions where contract_id = p_contract_id and reversed_at is null
  ) then
    raise exception 'blocked_extended';
  end if;

  -- 2b. guard: ห้าม regen ถ้ามีงวดที่ชำระแล้ว (paid_at is not null)
  if exists (
    select 1 from installments
    where contract_id = p_contract_id
      and paid_at is not null
  ) then
    raise exception 'blocked_paid';
  end if;

  -- 3. ลบงวดที่ยังไม่ชำระทั้งหมด
  --    (guard ด้านบนยืนยันแล้วว่าไม่มีแถวที่ paid_at is not null)
  delete from installments
  where contract_id = p_contract_id
    and paid_at is null;

  -- 4. สร้างงวดใหม่
  --    base = วันที่ 1 ของเดือน (transaction_date) + i เดือน
  --    ใช้ due_date_for() (จาก 0001) เพื่อ clamp ปลายเดือน
  for i in 1..v_term_months loop
    v_base := (date_trunc('month', v_transaction_date) + make_interval(months => i))::date;
    v_due  := due_date_for(
      extract(year  from v_base)::int,
      extract(month from v_base)::int,
      v_due_day
    );
    insert into installments (contract_id, installment_no, due_date, amount, status)
    values (p_contract_id, i, v_due, v_monthly_payment, 'pending');
  end loop;
end;
$$;

do $mig$
declare
  g1 text[] := array['autoclose_contract_if_fully_paid','reconcile_pj_receipts','record_payment_spread','run_daily_update'];
  g2 text[] := array['clear_promise_on_pay','credit_check_autolink_from_contract','handle_new_user','log_grade_change','sync_promise_to_pay','contracts_review_guard'];
  g3 text[] := array[
    'record_payment_with_penalty','record_penalty_only_payment','pj_review_set_penalty','regen_installments',
    'adjust_payment','admin_set_installment_penalty','approve_review','assign_case','cancel_payment','claim_case',
    'close_contract_early_preserve_schedule','close_returned_contract','create_transfer_slip','cutover_transfer_invoice',
    'delete_contract','force_mark_summary_shop_sent','get_collector_collection_by_bucket','import_pj_batch',
    'log_media_gate_bypass','media_soft_delete','record_payment','reject_review','release_case','revert_doc_receipt',
    'set_summary_note','settle_contract_early','staff_set_installment_penalty','submit_for_review',
    'transfer_contract_owner','undo_close_contract_early','undo_contract_transfer','update_contract_transfer_date',
    'void_transfer_slip',
    -- รอบ 2: ฟังก์ชันอ่าน/คำนวณที่ anon เรียกได้ แต่เว็บใช้หลังล็อกอินเท่านั้น (ไม่แก้เนื้อ)
    'find_media_duplicate','media_gate_complete','media_storage_usage_bytes','penalty_accrual_for_installment','penalty_paid_for_installment','returned_watch_our_paid','get_collector_ever_held','get_collector_ownership','get_collector_recoveries','get_collector_scorecard','get_collector_call_outcomes','get_freelancer_hr_daily_log','get_freelancer_hr_by_day','get_my_collector_scorecard','get_uncredited_collected','get_unowned_arrears','mark_installment_paid','mark_summary_accounting_sent','mark_summary_shop_sent','get_freelancer_perf','get_promise_attribution'];
  r record;
  v_bad text;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname, (p.prorettype = 'pg_catalog.trigger'::regtype) as is_trg
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and pg_get_userbyid(p.proowner) = current_user
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and (p.proname = any(g1) or p.proname = any(g2) or p.proname = any(g3) or p.prorettype = 'pg_catalog.trigger'::regtype)
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    if r.is_trg or r.proname = any(g2) then
      execute format('revoke all on function %s from authenticated, service_role', r.sig);
    elsif r.proname = any(g1) then
      execute format('revoke all on function %s from authenticated', r.sig);
      execute format('grant execute on function %s to service_role', r.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', r.sig);
    end if;
  end loop;

  -- ยืนยันในไฟล์เอง: ถ้ายังมีตัวไหนเปิดให้ anon -> ยกเลิกทั้ง migration
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
     and (p.proname = any(g1) or p.proname = any(g2) or p.proname = any(g3) or p.prorettype = 'pg_catalog.trigger'::regtype)
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('public', p.oid, 'EXECUTE')) ;
  if v_bad is not null then
    raise exception '0186: ยังเปิดให้ anon: %', v_bad;
  end if;
end
$mig$;
