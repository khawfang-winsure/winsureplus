-- 0131: RPC ปิดสัญญาก่อนกำหนดแบบ "คงตารางงวด" (Pete นิยาม 25 ก.ค. 2026 — ทำมือสำเร็จแล้ว 5 เคส) ให้พนักงานกดเองในเว็บได้
--
-- ============================================================================
-- บริบท:
--   ทีมเคยปิดสัญญาก่อนกำหนดด้วยมือ 4 วิธีต่างกัน (ยุบตารางงวด / settle_contract_early มิ.ย. 0078 ที่ mark
--   ทุกงวดจ่ายเต็ม=ContractDetail เฟ้อ / ปิดเฉยๆ / คงตาราง) ทำให้ข้อมูลไม่สม่ำเสมอ — ดู
--   early-close-preserve-schedule-2026-07-25 (เคสสิรีธร S00032PNQ029) Pete เคาะวิธีมาตรฐานใหม่:
--     1) payment_log 1 แถว: installment_id = งวดแรกที่ยังไม่จ่าย (ห้าม null — null จะถูกนับเป็นเงินดาวน์
--        ผิดที่ใน sale-history), amount = ยอดจ่ายปิด, penalty_paid_amount = ค่าปรับที่เก็บ,
--        created_at = วันปิด (ไม่ใช่ now())
--     2) other_income แถวละ 1 ค่าธรรมเนียม: fee_kind='settle' เสมอ (ไม่งั้น fee-reconcile ค้าง pending
--        ตลอด — ดู fee-reconcile-feature-2026-07-13), received_at = วันปิด
--     3) contracts: status='closed', settled_at, settlement_paid/discount/remaining
--     4) ห้าม UPDATE installments แม้แต่แถวเดียว — งวดที่เหลือหายจากหนี้/NPL/overdue เองเพราะ
--        v_contract_status suppress เมื่อ status ไม่ใช่ active/returned (ยืนยันแล้วจริง days_late=0)
--        + กันชนกับ trigger autoclose (0124) ที่ fire ตอน installments.paid_at เปลี่ยนค่า null→not null
--        เท่านั้น (WHEN clause) — เราไม่แตะคอลัมน์นี้เลย trigger นั้นเลยไม่มีทางถูกกระตุ้นจากทางนี้
--
--   งานนี้ทำ RPC มาตรฐาน (แยกจาก 0078 เดิม ไม่แตะ/ลบของเก่า — settle_contract_early ยังอยู่ปกติ) +
--   ตาราง contract_close_events เก็บ audit ว่า event ไหนสร้างแถวอะไรไว้บ้าง ให้ undo ย้อนได้แม่นยำ
--   ไม่ต้องเดาจาก note/สแกน payment_log ทีหลัง
--
-- กติกาที่ Pete ล็อกแล้ว (ตรงกับ pure function computeEarlyClose ใน src/lib/earlyClose.ts — แบมเขียน
--   คู่ขนาน, RPC นี้เป็นแค่ตัวลงบันทึกหลัง client คำนวณ/validate มาแล้วชั้นหนึ่ง — RPC ตรวจซ้ำอีกชั้น
--   เพราะเป็น SECURITY DEFINER เรียกตรงได้โดยไม่ผ่าน UI):
--   - ค่าปรับค้าง = ห้ามเก็บขาด แต่เก็บเกินได้ (แก้ 27 ก.ค. 2026 — เวอร์ชันแรก "เท่ากันเป๊ะ" เจอความเสี่ยง
--     เก็บซ้ำจริง 2 สัญญา active รวม 600 ฿ เพราะนับ penalty_amount ดิบไม่หักค่าปรับที่เคยเก็บไปแล้วบางส่วน):
--       v_penalty_due = Σ greatest(0, penalty_amount − penalty_paid_for_installment(id)) ของงวดที่ยัง
--       ไม่จ่าย (paid_at is null) — penalty_paid_for_installment (0115, cancel-aware) หักส่วนที่เก็บไปแล้ว
--       ออกก่อน กัน "เรียกเก็บซ้ำ" ค่าปรับที่ลูกค้าจ่ายไปแล้วบางส่วนก่อนหน้าการปิด
--     guard: p_penalty_received ต้อง >= v_penalty_due (round 2 ตำแหน่ง) — เก็บเกินได้ (PJ คิดค่าปรับสะสม
--     รายวันมักเกินเพดาน 700 ของเรา ยืนยันแล้ว 342 งวด) ห้ามเก็บขาด ไม่มี waive
--   - ค่าธรรมเนียม (p_fees) ไม่บังคับ — 0..n รายการ, แต่ละแถว amount>0 ต้องมี category (ไม่งั้น error)
--
-- Additive only — ตารางใหม่ทั้งก้อน + ฟังก์ชันใหม่ 2 ตัว ไม่แตะ 0078/0011/0054/0106/0080/0124
-- ============================================================================


-- ============================================================================
-- SECTION 1: ตาราง contract_close_events (audit ผูก event ↔ แถวที่สร้าง เพื่อ undo แม่นยำ)
-- ============================================================================

create table if not exists public.contract_close_events (
  id                    uuid primary key default gen_random_uuid(),
  contract_id           uuid not null references public.contracts(id) on delete cascade,
  method                text not null default 'preserve_schedule',
  payment_log_id        uuid references public.payment_log(id) on delete set null,
  other_income_ids      uuid[] not null default '{}',
  settlement_paid       numeric not null default 0,
  settlement_discount   numeric not null default 0,
  settlement_remaining  numeric not null default 0,
  penalty_received      numeric not null default 0,
  closed_at             date not null,
  closed_by             uuid references public.profiles(id),
  created_at            timestamptz not null default now(),
  undone_at             timestamptz,
  undone_by             uuid references public.profiles(id),
  undo_reason           text
);

create index if not exists contract_close_events_contract_idx
  on public.contract_close_events(contract_id);

-- กันกดปิดซ้ำสร้าง event ซ้อนบนสัญญาเดียวกันแบบ "ยังไม่ยกเลิก" มากกว่า 1 แถว (safety net เสริม —
-- ปกติ RPC ด้านล่างกันไว้แล้วด้วย guard status='active', แต่ใส่ไว้กันชนที่ระดับ schema ด้วยอีกชั้น)
create unique index if not exists contract_close_events_active_uidx
  on public.contract_close_events(contract_id)
  where undone_at is null;

-- RLS: อ่านได้ทุกคนที่ล็อกอิน (mirror payment_log 0011 — audit log อ่านได้หมด เขียนผ่าน RPC เท่านั้น)
alter table public.contract_close_events enable row level security;

drop policy if exists contract_close_events_read on public.contract_close_events;
create policy contract_close_events_read on public.contract_close_events
  for select to authenticated
  using (true);

-- authenticated: SELECT เท่านั้น (INSERT/UPDATE ทำผ่าน RPC security definer ด้านล่าง ซึ่งรันด้วย
-- สิทธิ์เจ้าของฟังก์ชัน ข้าม RLS/grant นี้อยู่แล้ว — ไม่ต้อง grant insert/update ให้ authenticated ตรงๆ)
grant select on public.contract_close_events to authenticated;

-- service_role: full (0017 ALTER DEFAULT PRIVILEGES ครอบให้แล้วเพราะอยู่ public.* แต่ใส่ชัดๆ ไว้ด้วย)
grant select, insert, update, delete on public.contract_close_events to service_role;


-- ============================================================================
-- SECTION 2: RPC close_contract_early_preserve_schedule — ปิดสัญญาก่อนกำหนด (คงตารางงวด)
-- ============================================================================
create or replace function public.close_contract_early_preserve_schedule(
  p_contract_id      uuid,
  p_settlement_paid  numeric,
  p_penalty_received numeric,
  p_closed_at        date,
  p_fees             jsonb default '[]'::jsonb,   -- '[{"category":"ค่าดำเนินการ","amount":6000}, ...]'
  p_note             text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role            text;
  v_by_name         text;
  v_contract_status text;
  v_unpaid_count    int;
  v_remaining       numeric;
  v_penalty_due     numeric;
  v_discount        numeric;
  v_anchor_id       uuid;
  v_anchor_amount   numeric;
  v_payment_log_id  uuid;
  v_event_id        uuid;
  v_fee_item        jsonb;
  v_fee_amount      numeric;
  v_fee_category    text;
  v_fee_oi_id       uuid;
  v_other_income_ids uuid[] := '{}';
begin
  -- ---------------------------------------------------------------------
  -- SECURITY GUARD: เฉพาะ admin/staff (pattern เดียวกับ staff_set_installment_penalty 0127)
  -- ---------------------------------------------------------------------
  select role into v_role from public.profiles where id = auth.uid();

  if v_role is null or v_role not in ('admin', 'staff') then
    raise exception 'ไม่มีสิทธิ์ปิดสัญญาก่อนกำหนด';
  end if;

  select coalesce(nullif(full_name, ''), '') into v_by_name
    from public.profiles where id = auth.uid();

  -- ---------------------------------------------------------------------
  -- ล็อกแถวสัญญา + ตรวจสถานะต้อง active เท่านั้น
  -- ---------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------
  -- ตรวจยอดเงินพื้นฐาน (ไม่ null / ไม่ติดลบ) + วันที่ปิดไม่เกินวันนี้
  -- ---------------------------------------------------------------------
  if p_settlement_paid is null or p_settlement_paid < 0 then
    raise exception 'ยอดจ่ายปิดต้องไม่ติดลบ: %', p_settlement_paid;
  end if;

  if p_penalty_received is null or p_penalty_received < 0 then
    raise exception 'ยอดค่าปรับที่เก็บต้องไม่ติดลบ: %', p_penalty_received;
  end if;

  if p_closed_at is null then
    raise exception 'ต้องระบุวันที่ปิดสัญญา';
  end if;

  if p_closed_at > current_date then
    raise exception 'วันที่ปิดสัญญาต้องไม่เกินวันนี้';
  end if;

  -- ---------------------------------------------------------------------
  -- ล็อกงวดที่ยังไม่จ่ายทั้งหมดก่อนคำนวณยอด (กัน race กับการรับชำระพร้อมกันจาก transaction อื่น)
  -- ---------------------------------------------------------------------
  perform 1
    from public.installments
   where contract_id = p_contract_id
     and paid_at is null
   for update;

  -- v_penalty_due หักค่าปรับที่เก็บไปแล้วบางส่วนออกก่อน (penalty_paid_for_installment, cancel-aware,
  -- mig 0115) — กันเรียกเก็บซ้ำ (แก้ 27 ก.ค. 2026 หลังเจอ 2 สัญญา active รวม 600 ฿ ที่จะโดนเรียกซ้ำ
  -- ถ้าใช้ penalty_amount ดิบตรงๆ)
  select count(*),
         coalesce(sum(greatest(0, amount - coalesce(paid_amount, 0))), 0),
         coalesce(sum(greatest(0, penalty_amount - public.penalty_paid_for_installment(id))), 0)
    into v_unpaid_count, v_remaining, v_penalty_due
    from public.installments
   where contract_id = p_contract_id
     and paid_at is null;

  if v_unpaid_count = 0 then
    raise exception 'สัญญานี้ไม่มีงวดค้าง ปิดก่อนกำหนดไม่ได้';
  end if;

  -- งวดแรกที่ยังไม่จ่าย (installment_no ต่ำสุดในกลุ่มค้าง) — ผูก payment_log ห้าม null
  select id, amount into v_anchor_id, v_anchor_amount
    from public.installments
   where contract_id = p_contract_id
     and paid_at is null
   order by installment_no asc
   limit 1;

  -- ---------------------------------------------------------------------
  -- ตรวจยอดจ่ายปิด <= ยอดคงเหลือตามตาราง
  -- ---------------------------------------------------------------------
  if p_settlement_paid > v_remaining then
    raise exception 'ยอดจ่ายปิดมากกว่ายอดคงเหลือตามตาราง (% ฿)', v_remaining;
  end if;

  -- ---------------------------------------------------------------------
  -- ห้ามเก็บค่าปรับค้างขาด (เก็บเกินได้ — PJ มักคิดค่าปรับสะสมเกินเพดาน 700 ของเรา) ไม่มี waive
  -- ---------------------------------------------------------------------
  if round(p_penalty_received, 2) < round(v_penalty_due, 2) then
    raise exception 'ต้องเก็บค่าปรับค้างอย่างน้อย % ฿ (ถ้าต้องการลดค่าปรับ ให้แก้ยอดค่าปรับรายงวดก่อน)', v_penalty_due;
  end if;

  v_discount := v_remaining - p_settlement_paid;

  -- assert เชิงป้องกัน (ควรเป็นจริงเสมอเพราะ v_discount derive จากสมการนี้ตรงๆ — กันเผื่อแก้โค้ดพลาดวันหน้า)
  if round(p_settlement_paid + v_discount, 2) <> round(v_remaining, 2) then
    raise exception 'ยอดไม่สมดุลภายใน (จ่าย + ส่วนลด ต้องเท่ากับยอดคงเหลือ) — ติดต่อผู้ดูแลระบบ';
  end if;

  -- ---------------------------------------------------------------------
  -- ประมวลผลค่าธรรมเนียม (0..n รายการ) — validate ทีละแถว แล้วค่อย insert other_income
  -- ---------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------
  -- payment_log แถวเดียว = เงินสดจริงที่รับปิด (ห้าม null installment_id — null จะถูกนับเป็นเงินดาวน์)
  -- ⚠️ ห้าม UPDATE installments — คงตารางงวดเดิม (หัวใจของวิธีนี้)
  -- ---------------------------------------------------------------------
  insert into public.payment_log (
    contract_id, installment_id, action, amount, penalty_paid_amount,
    paid_amount_after, by_name, note, created_at
  ) values (
    p_contract_id, v_anchor_id, 'pay', p_settlement_paid, p_penalty_received,
    p_settlement_paid, v_by_name,
    'ปิดสัญญาก่อนกำหนด (คงตารางงวด, ส่วนลด ' || v_discount || ')' ||
      case when p_note is not null and btrim(p_note) <> '' then ' — ' || p_note else '' end,
    p_closed_at::timestamptz
  ) returning id into v_payment_log_id;

  -- ---------------------------------------------------------------------
  -- ปิดสัญญา + เก็บ audit ยอดที่คิด (คอลัมน์เดิมจาก 0078 — ไม่ต้องเพิ่มคอลัมน์ใหม่)
  -- ---------------------------------------------------------------------
  update public.contracts
     set status               = 'closed',
         settled_at           = p_closed_at::timestamptz,
         settlement_discount  = v_discount,
         settlement_remaining = v_remaining,
         settlement_paid      = p_settlement_paid,
         settled_by           = v_by_name
   where id = p_contract_id;

  -- ---------------------------------------------------------------------
  -- กัน PJ auto-sync ดูดเงินก้อนนี้มาลงซ้ำในวันเดียวกัน (pattern เดียวกับ pj_applied_ledger 0080)
  -- on conflict do nothing: ถ้ามี ledger ของวันนั้นอยู่แล้ว (เช่น auto-sync ลงไปก่อนหน้า) ไม่ทับของเดิม
  -- ---------------------------------------------------------------------
  insert into public.pj_applied_ledger (contract_id, pj_paid_date, inst_amount, pen_amount, source)
  values (p_contract_id, p_closed_at, p_settlement_paid, p_penalty_received, 'settle')
  on conflict (contract_id, pj_paid_date) do nothing;

  -- ---------------------------------------------------------------------
  -- บันทึก event สำหรับ undo ย้อนหลังแม่นยำ
  -- ---------------------------------------------------------------------
  insert into public.contract_close_events (
    contract_id, method, payment_log_id, other_income_ids,
    settlement_paid, settlement_discount, settlement_remaining, penalty_received,
    closed_at, closed_by
  ) values (
    p_contract_id, 'preserve_schedule', v_payment_log_id, v_other_income_ids,
    p_settlement_paid, v_discount, v_remaining, p_penalty_received,
    p_closed_at, auth.uid()
  ) returning id into v_event_id;

  return v_event_id;
end;
$$;

grant execute on function public.close_contract_early_preserve_schedule(uuid, numeric, numeric, date, jsonb, text)
  to authenticated, service_role;

comment on function public.close_contract_early_preserve_schedule(uuid, numeric, numeric, date, jsonb, text) is
  '(0131) ปิดสัญญาก่อนกำหนดแบบคงตารางงวด (Pete นิยาม 25 ก.ค. 2026): admin/staff เท่านั้น; ต้องมีงวดค้าง>=1;
   p_settlement_paid<=ยอดคงเหลือ(Σmax(0,amount-paid_amount) ของงวด paid_at is null);
   p_penalty_received ต้อง >= Σgreatest(0,penalty_amount-penalty_paid_for_installment(id)) ของงวดค้าง
   (เก็บเกินได้ ห้ามขาด แก้ 27 ก.ค. 2026 กันเรียกเก็บค่าปรับซ้ำ ไม่มี waive); insert payment_log 1 แถวผูก
   งวดแรกที่ค้าง (ห้าม null) + other_income ต่อค่าธรรมเนียม (fee_kind=settle) + flip contracts→closed +
   pj_applied_ledger กันซ้ำ + บันทึก contract_close_events ไว้ undo; ห้าม UPDATE installments เด็ดขาด
   (หัวใจของวิธีนี้)';


-- ============================================================================
-- SECTION 3: RPC undo_close_contract_early — ยกเลิกการปิด (admin เท่านั้น, idempotent)
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

  -- 1) ลบ payment_log ของงวดที่ผูกไว้ (เผื่อโดนลบไปก่อนแล้วด้วยเหตุอื่น — id null ก็ไม่พัง)
  if v_event.payment_log_id is not null then
    delete from public.payment_log where id = v_event.payment_log_id;
  end if;

  -- 2) ลบ other_income ทุกแถวที่ event นี้สร้างไว้
  if v_event.other_income_ids is not null and array_length(v_event.other_income_ids, 1) > 0 then
    delete from public.other_income where id = any(v_event.other_income_ids);
  end if;

  -- 3) ลบ ledger กันซ้ำ PJ เฉพาะที่มาจาก event นี้ (source='settle' ของสัญญา+วันนี้เท่านั้น —
  --    ไม่แตะ ledger ของ auto-sync/เคสอื่นที่บังเอิญวันเดียวกัน)
  delete from public.pj_applied_ledger
   where contract_id = v_event.contract_id
     and pj_paid_date = v_event.closed_at
     and source = 'settle';

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

grant execute on function public.undo_close_contract_early(uuid, text)
  to authenticated, service_role;

comment on function public.undo_close_contract_early(uuid, text) is
  '(0131) ยกเลิกการปิดสัญญาก่อนกำหนด (preserve_schedule) — admin เท่านั้น; ลบ payment_log+other_income ที่
   event อ้างถึง, ลบ pj_applied_ledger เฉพาะ source=settle ของวันปิดนั้น, คืน contracts เป็น active +
   เคลียร์ settlement_*; idempotent (ยกเลิกซ้ำ = error ภาษาไทย ไม่ใช่พัง)';


-- ============================================================================
-- Verify checklist สำหรับ Cream รันหลัง apply (MCP) — dry-run ด้วย begin/rollback ก่อนเสมอ
-- ============================================================================

-- a) ตาราง + ฟังก์ชันสร้างสำเร็จ:
-- select table_name from information_schema.tables
--  where table_schema='public' and table_name='contract_close_events';
-- select routine_name from information_schema.routines
--  where routine_schema='public'
--    and routine_name in ('close_contract_early_preserve_schedule','undo_close_contract_early');
-- -- expected: 1 row / 2 rows

-- b) authenticated มีสิทธิ์ execute + select บนตารางใหม่:
-- select has_function_privilege('authenticated',
--   'public.close_contract_early_preserve_schedule(uuid, numeric, numeric, date, jsonb, text)', 'EXECUTE');
-- select has_function_privilege('authenticated',
--   'public.undo_close_contract_early(uuid, text)', 'EXECUTE');
-- select has_table_privilege('authenticated', 'public.contract_close_events', 'SELECT');
-- -- expected: true / true / true

-- c) service_role SELECT บนตารางใหม่ (Edge Function ถ้าวันหน้าต้องใช้):
-- select has_table_privilege('service_role', 'public.contract_close_events', 'SELECT');
-- -- expected: true

-- d) trace หลัก — สัญญา active มีงวดค้าง 3 งวด (งวด#2 จ่ายบางส่วน 300/1000 penalty 200 ยังไม่เคยเก็บค่าปรับ
--    บางส่วนมาก่อน (penalty_paid_for_installment=0) เลย v_penalty_due=200 เท่าเดิมของ trace นี้, งวด#3 เต็ม 1000):
--    ทดสอบผ่าน session staff/admin จริง (auth.uid() ต้อง map profile role admin/staff — service_role
--    ใน SQL Editor ตรงๆ ไม่มี auth.uid() จะชน guard ไม่มีสิทธิ์เสมอ ต้องรันผ่านแอปจริงหรือ JWT staff/admin):
--   begin;
--     select installment_no, amount, paid_amount, paid_at, penalty_amount
--       from public.installments where contract_id = '<contract_id>' order by installment_no;
--     select public.close_contract_early_preserve_schedule(
--       '<contract_id>'::uuid, 1700, 200, current_date, '[{"category":"ค่าดำเนินการ","amount":300}]'::jsonb, 'ทดสอบครีม'
--     );
--     -- expected: คืน uuid ของ event, ไม่ error
--     select status, settled_at, settlement_paid, settlement_discount, settlement_remaining from public.contracts where id = '<contract_id>'::uuid;
--     -- expected: closed / วันนี้ / 1700 / 0 / 1700
--     select installment_no, paid_at, paid_amount from public.installments where contract_id = '<contract_id>'::uuid order by installment_no;
--     -- expected: ทุกแถวเหมือนเดิมทุกประการ (ห้ามมีการเปลี่ยนแปลง — คงตารางงวด)
--     select action, installment_id, amount, penalty_paid_amount, created_at from public.payment_log
--       where contract_id = '<contract_id>'::uuid order by created_at desc limit 1;
--     -- expected: pay / installment_id ของงวด#2 (ต่ำสุดที่ยังค้าง) ไม่ null / 1700 / 200 / created_at = closed_at เที่ยงคืน
--     select category, amount, fee_kind from public.other_income where contract_id = '<contract_id>'::uuid order by created_at desc limit 1;
--     -- expected: ค่าดำเนินการ / 300 / settle
--     select contract_id, pj_paid_date, inst_amount, pen_amount, source from public.pj_applied_ledger
--       where contract_id = '<contract_id>'::uuid and pj_paid_date = current_date;
--     -- expected: 1 row, source=settle
--   rollback;

-- e) guard ค่าปรับเก็บขาด (ต่ำกว่า v_penalty_due) ต้องโดน error — เก็บ "เกิน" ต้องผ่าน (แก้ 27 ก.ค. 2026):
--   select public.close_contract_early_preserve_schedule('<contract_id>'::uuid, 1700, 100, current_date, '[]'::jsonb);
--   -- expected: ERROR ต้องเก็บค่าปรับค้างอย่างน้อย 200 ฿ ...
--   select public.close_contract_early_preserve_schedule('<contract_id>'::uuid, 1700, 800, current_date, '[]'::jsonb);
--   -- expected: ผ่าน (800 >= 200 v_penalty_due — เก็บเกินไม่ error, ตรงเคส PJ คิดค่าปรับสะสมเกิน 700)

-- e2) guard v_penalty_due หักค่าปรับที่เก็บไปแล้วบางส่วนถูกต้อง — สมมติงวด#2 เคยเก็บค่าปรับไปแล้ว 150 บาท
--    (penalty_paid_for_installment=150) จาก penalty_amount=200 → v_penalty_due ควรเหลือ 50 ไม่ใช่ 200:
--   select public.penalty_paid_for_installment('<installment_id_งวด2>'::uuid); -- expected: 150
--   select public.close_contract_early_preserve_schedule('<contract_id>'::uuid, 1700, 40, current_date, '[]'::jsonb);
--   -- expected: ERROR ต้องเก็บค่าปรับค้างอย่างน้อย 50 ฿ ... (ไม่ใช่ 200 — พิสูจน์ว่าหักส่วนที่เก็บไปแล้วจริง)
--   select public.close_contract_early_preserve_schedule('<contract_id>'::uuid, 1700, 50, current_date, '[]'::jsonb);
--   -- expected: ผ่าน

-- f) guard ยอดจ่ายเกินยอดคงเหลือ:
--   select public.close_contract_early_preserve_schedule('<contract_id>'::uuid, 5000, 200, current_date, '[]'::jsonb);
--   -- expected: ERROR ยอดจ่ายปิดมากกว่ายอดคงเหลือตามตาราง (1700 ฿)

-- g) guard สัญญาไม่ active (ลองซ้ำหลัง d ปิดไปแล้ว):
--   select public.close_contract_early_preserve_schedule('<contract_id>'::uuid, 100, 0, current_date, '[]'::jsonb);
--   -- expected: ERROR ปิดก่อนกำหนดได้เฉพาะสัญญาที่ยัง active เท่านั้น (สถานะปัจจุบัน: closed)

-- h) guard ไม่มีงวดค้าง (สัญญาที่จ่ายครบทุกงวดแล้วแต่ยัง active ค้างสถานะ — เคสหายาก):
--   select public.close_contract_early_preserve_schedule('<contract_id_no_unpaid>'::uuid, 0, 0, current_date, '[]'::jsonb);
--   -- expected: ERROR สัญญานี้ไม่มีงวดค้าง ปิดก่อนกำหนดไม่ได้

-- i) guard fee ไม่มี category:
--   select public.close_contract_early_preserve_schedule('<contract_id>'::uuid, 1700, 200, current_date, '[{"category":"","amount":100}]'::jsonb);
--   -- expected: ERROR กรุณาระบุประเภทค่าธรรมเนียม

-- j) guard role อื่น (freelancer/executive/accounting) ต้องโดนบล็อก:
--   select public.close_contract_early_preserve_schedule('<any_contract_id>'::uuid, 0, 0, current_date, '[]'::jsonb);
--   -- expected: ERROR ไม่มีสิทธิ์ปิดสัญญาก่อนกำหนด

-- k) undo happy path (ต่อจาก d, ยังไม่ rollback — หรือรันในบล็อกใหม่ที่ทำ d ซ้ำแบบ commit จริงในสภาพแวดล้อม dev):
--   begin;
--     select public.undo_close_contract_early('<event_id_จาก_d>'::uuid, 'ทดสอบยกเลิก ครีม');
--     select status, settled_at, settlement_paid from public.contracts where id = '<contract_id>'::uuid;
--     -- expected: active / null / null
--     select count(*) from public.payment_log where id = '<payment_log_id_จาก_d>'::uuid; -- expected: 0
--     select count(*) from public.other_income where id = any(array['<other_income_id_จาก_d>']::uuid[]); -- expected: 0
--     select count(*) from public.pj_applied_ledger where contract_id = '<contract_id>'::uuid and pj_paid_date = current_date and source='settle'; -- expected: 0
--   rollback;

-- l) undo ซ้ำต้อง error ไม่ใช่พัง:
--   select public.undo_close_contract_early('<event_id_เดิม>'::uuid, 'ลองซ้ำ');
--   -- expected: ERROR รายการนี้ถูกยกเลิกไปแล้วเมื่อ ...

-- m) undo โดยไม่ใช่ admin ต้องโดนบล็อก:
--   select public.undo_close_contract_early('<any_event_id>'::uuid, 'ทดสอบ staff'); -- session staff
--   -- expected: ERROR เฉพาะแอดมินเท่านั้นที่ยกเลิกการปิดสัญญาก่อนกำหนดได้

-- n) sanity trigger 0124 ไม่ถูกกระตุ้นผิดที่ — ระหว่าง d ห้ามมี installments แถวไหนถูกแตะเลย (ตรวจซ้ำข้อ d)
--    + สัญญาอื่นที่ status ไม่ใช่ active (returned/closed เดิม) ต้องไม่ได้รับผลกระทบจากการรัน d/e/f/g/h/i
