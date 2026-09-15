-- 0158: ฟีเจอร์ "เปลี่ยนผู้ผ่อน" (transfer owner) — ผูกเลขที่ใบ PJ ใหม่ (cutover) + กันเงินซ้ำ/แจ้งเตือนผี
-- ────────────────────────────────────────────────────────────────────────────
-- บริบท (ดู scratchpad transfer-owner-brief.md "PJ mechanism"): ร้านมักคีย์ใบเสร็จเก่าของคนเดิม
-- ย้ายไปไว้ใต้เลขที่ใบ PJ ใหม่ของคนใหม่ (ก) — ถ้าปล่อยให้ pj-sync/reconcile (0114) เห็นตามปกติ จะเข้าใจผิดว่า
-- เป็นใบเสร็จใหม่ (เงินซ้ำ) หรือใบเดิมหายจาก PJ (แจ้งเตือนผี) ทั้งที่ไม่มีเงินเข้า/ออกจริงเลย —
-- migration นี้แก้ด้วย 2 ตาราง (แคชข้อมูลที่ดึงมาก่อนผูก + รายการ "ใบที่ต้องข้าม") + RPC เดียวที่ผูกเลขจริง
--
-- ต้อง apply หลัง 0157 เท่านั้น (deploy order fixed: 0157 → 0158 → pj-sync → pj-snapshot → frontend — ดู brief)
-- เพราะ SECTION 4 ทำ create or replace undo_contract_transfer ทับเวอร์ชันฐานของ 0157 (ต้องมี
-- contract_transfers/pj_receipt_ignores ให้ reference ก่อน)
--
-- ห้ามแตะเงิน/installments/payment_log/other_income ทั้งไฟล์นี้ — งานนี้แค่ "ผูกเลขที่ใบ" + "บอก pj-sync
-- ว่าใบไหนไม่ต้องสนใจ" เท่านั้น
--
-- Additive/idempotent — เหมือน 0157

-- ============================================================================
-- SECTION 0: เพิ่มคอลัมน์ audit ของ cutover บน contract_transfers (additive — ติ๊กรีวิว ORANGE #3, 2026-09-14)
-- เก็บยอดที่เทียบกันตอน cutover ไว้ทุกครั้ง (เผื่อสอบย้อนหลังว่าทำไมยอมให้ override ตอนยอดไม่ตรง)
-- ============================================================================

alter table public.contract_transfers
  add column if not exists cutover_pj_total       numeric,
  add column if not exists cutover_our_total       numeric,
  add column if not exists cutover_matched         boolean,
  add column if not exists cutover_override_reason text,
  add column if not exists cutover_by              uuid references public.profiles (id),
  add column if not exists cutover_by_name         text;

comment on column public.contract_transfers.cutover_pj_total is
  '(0158) ยอดรวมที่ PJ ตอบกลับมาตอน cutover (pj_invoice_prechecks.total ณ ตอนนั้น) — เก็บ audit เทียบย้อนหลังได้';
comment on column public.contract_transfers.cutover_our_total is
  '(0158) ยอดที่เราคำนวณเอง (ดาวน์+งวด+ค่าปรับ cancel-aware+รายได้อื่นๆ ยกเว้นค่าเอกสาร) ณ ตอน cutover';
comment on column public.contract_transfers.cutover_matched is
  '(0158) true = ยอดตรงกันพอดีตอน cutover; false = ไม่ตรง (ต้อง admin+เหตุผลถึงผ่านได้ — ดู cutover_override_reason)';
comment on column public.contract_transfers.cutover_override_reason is
  '(0158) เหตุผลที่แอดมินยืนยันแม้ยอดไม่ตรง — null ถ้า cutover_matched=true';
comment on column public.contract_transfers.cutover_by is
  '(0158) ผู้กดผูกเลขที่ใบ PJ (auth.uid() ตอนเรียก cutover_transfer_invoice)';
comment on column public.contract_transfers.cutover_by_name is
  '(0158) snapshot ชื่อผู้กดผูก ณ ตอนนั้น';


-- ============================================================================
-- SECTION 1: ตาราง pj_invoice_prechecks — แคชใบเสร็จที่ดึงจากหน้าใบ PJ ของ INV ใหม่ ก่อนผูกจริง
-- เขียนได้ทาง service_role (Edge Function pj-snapshot) เท่านั้น กันข้อมูลถูกปลอมจากฝั่ง client แล้วเอาไปหลอก
-- cutover_transfer_invoice ว่ายอดตรงกัน
-- ============================================================================

create table if not exists public.pj_invoice_prechecks (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null references public.contracts (id) on delete cascade,
  pj_invoice_no text not null,
  receipts      jsonb not null default '[]'::jsonb,   -- [{uuid, payment_type, amount, paid_date}] ต่อใบเสร็จจริง
  total         numeric not null default 0,            -- Σ receipts.amount ที่ Edge Function คำนวณมาให้แล้ว
  fetched_by    uuid references public.profiles (id),
  fetched_at    timestamptz not null default now()
);

create index if not exists pj_invoice_prechecks_contract_idx
  on public.pj_invoice_prechecks (contract_id, fetched_at desc);

comment on table public.pj_invoice_prechecks is
  '(0158) รายการใบเสร็จที่ดึงจากหน้าใบ PJ ของ INV ใหม่ ตอนกด "ดึงข้อมูล PJ" ก่อนผูกเลขที่ใบ (cutover_transfer_invoice) — เขียนได้ทาง service_role (Edge Function pj-snapshot) เท่านั้น; cutover_transfer_invoice เทียบ fetched_at ต้อง <= 30 นาที ถึงจะใช้ได้ (กันข้อมูลเก่า)';
comment on column public.pj_invoice_prechecks.receipts is 'jsonb array ของใบเสร็จจริงใต้ INV นี้ที่ PJ ตอบกลับมา — key ต้องมี "uuid" (ใช้ insert เข้า pj_receipt_ignores ตรงๆ)';
comment on column public.pj_invoice_prechecks.total is 'ยอดรวม Σ receipts.amount — เทียบกับยอดที่เราคำนวณเอง (ดาวน์+งวด+ค่าปรับ cancel-aware+รายได้อื่นๆ) ใน cutover_transfer_invoice';

alter table public.pj_invoice_prechecks enable row level security;

drop policy if exists pj_invoice_prechecks_select on public.pj_invoice_prechecks;
create policy pj_invoice_prechecks_select on public.pj_invoice_prechecks
  for select to authenticated
  using (is_admin() or is_staff());

grant select on public.pj_invoice_prechecks to authenticated;
grant select, insert, update, delete on public.pj_invoice_prechecks to service_role;
-- ไม่มี insert/update/delete policy ให้ authenticated เลย (ตั้งใจ) — เขียนได้ทาง Edge Function (service_role) เท่านั้น
-- (กัน staff ปลอมยอด precheck จาก browser แล้วเอาไปหลอกการเทียบยอดใน cutover_transfer_invoice)


-- ============================================================================
-- SECTION 2: ตาราง pj_receipt_ignores — ใบเสร็จที่ pj-sync/reconcile (0114) ต้อง "ข้าม" หลัง cutover
-- คนละก้อนกับ pj_applied_receipts (0100, แปลว่า "เงินลงบัญชีแล้ว") — ตารางนี้แปลว่า "อย่าเอาไปลงบัญชี/แจ้งเตือน
-- อีก เพราะไม่ใช่เงินของสัญญาใหม่จริง เป็นใบเดิมของคนก่อนที่ร้านคีย์ย้ายมา"
-- ============================================================================

create table if not exists public.pj_receipt_ignores (
  pj_receipt_uuid text primary key,
  transfer_id     uuid not null references public.contract_transfers (id) on delete cascade,
  pj_invoice_no   text,
  amount          numeric,
  payment_type    text,
  pj_paid_date    date,
  created_at      timestamptz not null default now()
);

create index if not exists pj_receipt_ignores_transfer_idx
  on public.pj_receipt_ignores (transfer_id);

comment on table public.pj_receipt_ignores is
  '(0158) ใบเสร็จ PJ ที่ pj-sync/reconcile (0114) ต้อง "ข้าม" เพราะเป็นใบเก่าของคนก่อนหน้าที่ร้านคีย์ย้ายไปไว้ใต้เลขที่ใบ PJ ใหม่ตอนเปลี่ยนผู้ผ่อน — ⚠️ pj-sync ต้องโหลด set นี้มา "ตัดออกก่อน grouping" ทุก path (installment/penalty/other) ไม่งั้นใบเดิมจะถูกลงซ้ำใต้สัญญาเดียวกัน; เขียนผ่าน RPC cutover_transfer_invoice/undo_contract_transfer เท่านั้น';

alter table public.pj_receipt_ignores enable row level security;

drop policy if exists pj_receipt_ignores_select on public.pj_receipt_ignores;
create policy pj_receipt_ignores_select on public.pj_receipt_ignores
  for select to authenticated
  using (is_admin() or is_staff());

grant select on public.pj_receipt_ignores to authenticated;
grant select, insert, update, delete on public.pj_receipt_ignores to service_role;
-- ไม่มี insert/update/delete policy ให้ authenticated ตรง — เขียนผ่าน RPC (SECURITY DEFINER) เท่านั้น
-- service_role มี SELECT ทั้งจาก grant explicit ด้านบน และจาก default privileges ของ 0017 อยู่แล้ว (ซ้ำไว้ให้ชัด)
-- — pj-sync/index.ts (service_role) อ่านตารางนี้ทุกรอบเพื่อตัด uuid ออกก่อน grouping


-- ============================================================================
-- SECTION 3: RPC cutover_transfer_invoice — staff/admin ผูกเลขที่ใบ PJ ใหม่เข้าสัญญาจริง
-- ⚠️ signature เปลี่ยนจากดราฟต์แรก (ติ๊กรีวิว RED #2, 2026-09-14) — เพิ่ม p_new_inv_no (ตำแหน่งที่ 3, ก่อน
-- p_override_reason) เพราะ transfer_contract_owner (0157) อาจไม่ได้ใส่เลข INV ตอนเปิด transfer — cutover
-- เป็นจุดที่ "ผูกได้จริง" ครั้งสุดท้ายก่อนแตะ contracts.inv_no ต้อง DROP signature เก่า (3-arg) ก่อน CREATE
-- 4-arg ใหม่ กัน overload ซ้อนตาม precedent 0091/0100 (แม้ไฟล์นี้ยังไม่เคย apply มาก่อนก็ตาม — กันเคสมี
-- draft เก่าหลุด apply ไปก่อนหน้าโดยไม่ตั้งใจ)
-- ============================================================================

drop function if exists public.cutover_transfer_invoice(uuid, uuid, text);

create or replace function public.cutover_transfer_invoice(
  p_transfer_id     uuid,
  p_precheck_id     uuid,
  p_new_inv_no      text default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role          text;
  v_active         boolean;
  v_by_name        text;
  v_t              contract_transfers%rowtype;
  v_c              contracts%rowtype;
  v_p              pj_invoice_prechecks%rowtype;
  v_new_inv_no     text;
  v_precheck_inv   text;
  v_down           numeric;
  v_inst_paid      numeric;
  v_penalty_paid   numeric;
  v_other          numeric;
  v_our_total      numeric;
  v_matched        boolean;
begin
  -- ---------------------------------------------------------------------
  -- SECURITY GUARD: admin/staff (active) เท่านั้น — เหมือน transfer_contract_owner
  -- ---------------------------------------------------------------------
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    raise exception 'ไม่มีสิทธิ์ผูกเลขที่ใบ PJ';
  end if;

  select coalesce(nullif(full_name, ''), '') into v_by_name
    from public.profiles where id = auth.uid();

  select * into v_t from public.contract_transfers where id = p_transfer_id for update;
  if not found then
    raise exception 'ไม่พบรายการเปลี่ยนผู้ผ่อนนี้: %', p_transfer_id;
  end if;

  if v_t.reversed_at is not null then
    raise exception 'รายการเปลี่ยนผู้ผ่อนนี้ถูกยกเลิกไปแล้ว ผูกเลขที่ใบ PJ ไม่ได้';
  end if;

  if v_t.cutover_at is not null then
    raise exception 'สัญญานี้ผูกเลขที่ใบ PJ ใหม่ไปแล้วเมื่อ %', v_t.cutover_at;
  end if;

  -- ---------------------------------------------------------------------
  -- (RED fix #2) รับ p_new_inv_no ได้ตอน cutover เลย ถ้า transfer_contract_owner ตอนเปิดไม่ได้ใส่มา (หรือ
  -- จะแก้ก่อน cutover จริงก็ได้) — "ตั้งค่าก่อนเช็ค null" ด้านล่าง: normalize+ตรวจซ้ำแล้วเขียนทับ
  -- contract_transfers.new_inv_no ก่อนถึงเงื่อนไข "ยังไม่มีเลขที่ใบเลย" — อนุญาตได้เสมอเพราะผ่าน guard
  -- cutover_at is not null ด้านบนมาแล้ว (การันตีว่ายังไม่เคย cutover จริง = ยังแก้ new_inv_no ได้อยู่)
  -- ---------------------------------------------------------------------
  if p_new_inv_no is not null and btrim(p_new_inv_no) <> '' then
    v_new_inv_no := public.sanitize_inv_no(p_new_inv_no);
    if v_new_inv_no is null then
      raise exception 'เลขที่ใบ PJ ใหม่ไม่ถูกต้อง: %', p_new_inv_no;
    end if;
    if v_t.new_inv_no is distinct from v_new_inv_no then
      update public.contract_transfers set new_inv_no = v_new_inv_no where id = p_transfer_id;
      v_t.new_inv_no := v_new_inv_no;
    end if;
  else
    v_new_inv_no := public.sanitize_inv_no(v_t.new_inv_no);
  end if;

  if v_new_inv_no is null then
    raise exception 'รายการเปลี่ยนผู้ผ่อนนี้ยังไม่ได้ระบุเลขที่ใบ PJ ใหม่ กรุณาระบุก่อน (ส่ง p_new_inv_no มาพร้อมกันได้)';
  end if;

  select * into v_c from public.contracts where id = v_t.contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญานี้';
  end if;

  if exists (select 1 from public.contracts where inv_no = v_new_inv_no and id <> v_t.contract_id) then
    raise exception 'เลขที่ใบ INV นี้ถูกใช้กับสัญญาอื่นไปแล้ว: %', v_new_inv_no;
  end if;

  -- ---------------------------------------------------------------------
  -- precheck ต้องเป็นของสัญญาเดียวกัน + เลขที่ใบตรงกับ new_inv_no (normalize ทั้งสองข้าง) + อายุ <= 30 นาที
  -- ---------------------------------------------------------------------
  select * into v_p from public.pj_invoice_prechecks where id = p_precheck_id for update;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ดึงจาก PJ (precheck) นี้ — กรุณากดดึงข้อมูล PJ ใหม่';
  end if;

  if v_p.contract_id is distinct from v_t.contract_id then
    raise exception 'ข้อมูลที่ดึงจาก PJ (precheck) นี้ไม่ใช่ของสัญญานี้';
  end if;

  v_precheck_inv := public.sanitize_inv_no(v_p.pj_invoice_no);
  if v_precheck_inv is distinct from v_new_inv_no then
    raise exception 'เลขที่ใบใน PJ ที่ดึงมา (%) ไม่ตรงกับเลขที่ใบ PJ ใหม่ของรายการเปลี่ยนผู้ผ่อนนี้ (%)', v_precheck_inv, v_new_inv_no;
  end if;

  if v_p.fetched_at < now() - interval '30 minutes' then
    raise exception 'ข้อมูลจาก PJ เก่าเกินไป (ดึงไว้ตั้งแต่ %) กรุณากดดึงข้อมูล PJ ใหม่ก่อนผูก', v_p.fetched_at;
  end if;

  -- ---------------------------------------------------------------------
  -- ยอดเก็บของเราจริง = ดาวน์ + Σงวดที่จ่ายแล้ว + ค่าปรับที่เก็บแล้ว (cancel-aware) + Σรายได้อื่นๆ (ยกเว้นค่าเอกสาร)
  -- ดาวน์ = device_price × down_percent/100 (สูตรเดียวกับ downOf() ใน execDashboard.ts — ถือว่าดาวน์เก็บครบเสมอ
  -- ตอนทำสัญญา ไม่ผ่าน payment_log แยก — ดู comment ยาวในรายงานของน้องชีส)
  --
  -- (RED fix #1, ติ๊กรีวิว 2026-09-14) — ค่าเอกสาร (category='ค่าเอกสาร', backfill จาก doc_fee migration 0129,
  -- 2,410 สัญญา) ไม่เคยมาจากใบเสร็จ PJ เลย (เก็บนอกระบบ PJ ตั้งแต่ต้น) ต้องตัดออกจากยอดเทียบ ไม่งั้น
  -- our_total จะสูงกว่า PJ total เสมอทุกเคสที่มีค่าเอกสาร (false mismatch) — ตัดด้วย category ตรงตัว
  -- (marker เดียวกับ docfee-reclassify 0129 — ไม่ใช่ fee_kind) ห้ามกรองเหลือแค่ fee_kind='transfer' เด็ดขาด:
  -- ค่าธรรมเนียมหมวดอื่น (ค่าเปลี่ยนวันที่ชำระ/ค่าขยาย/ค่าธรรมเนียม PJ อื่นๆ) มักมาจากใบเสร็จ PJ จริง —
  -- ร้านคีย์ใบเดิมมาไว้ใต้ INV ใหม่ก็ติดยอดนี้มาด้วย ต้องนับรวม ไม่งั้นกลาย false mismatch อีกทาง (PJ
  -- total สูงกว่าที่เรานับ)
  -- ---------------------------------------------------------------------
  v_down := round(v_c.device_price * coalesce(v_c.down_percent, 0) / 100.0);

  select coalesce(sum(paid_amount), 0) into v_inst_paid
    from public.installments where contract_id = v_t.contract_id;

  select coalesce(sum(public.penalty_paid_for_installment(id)), 0) into v_penalty_paid
    from public.installments where contract_id = v_t.contract_id;

  select coalesce(sum(amount), 0) into v_other
    from public.other_income
   where contract_id = v_t.contract_id
     and category is distinct from 'ค่าเอกสาร';

  v_our_total := v_down + v_inst_paid + v_penalty_paid + v_other;
  v_matched := round(v_our_total, 2) = round(v_p.total, 2);

  if not v_matched then
    if not is_admin() then
      raise exception 'ยอดจาก PJ (% บาท) ไม่ตรงกับยอดที่เราบันทึกไว้ (% บาท) — ต้องให้แอดมินยืนยันเท่านั้น', v_p.total, v_our_total;
    end if;
    if p_override_reason is null or btrim(p_override_reason) = '' then
      raise exception 'ยอดจาก PJ (% บาท) ไม่ตรงกับยอดที่เราบันทึกไว้ (% บาท) — ต้องระบุเหตุผลก่อนดำเนินการต่อ', v_p.total, v_our_total;
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- (ก) บันทึก ignore ทุก uuid ที่ precheck เห็น — กัน pj-sync/reconcile จับใบเดิมของคนเก่ามาลงซ้ำ/แจ้งเตือนผี
  -- ---------------------------------------------------------------------
  insert into public.pj_receipt_ignores (pj_receipt_uuid, transfer_id, pj_invoice_no, amount, payment_type, pj_paid_date)
  select
    elem ->> 'uuid', p_transfer_id, v_new_inv_no,
    nullif(elem ->> 'amount', '')::numeric,
    elem ->> 'payment_type',
    nullif(elem ->> 'paid_date', '')::date
  from jsonb_array_elements(coalesce(v_p.receipts, '[]'::jsonb)) elem
  where elem ->> 'uuid' is not null
  on conflict (pj_receipt_uuid) do nothing;

  -- ---------------------------------------------------------------------
  -- ผูกเลขที่ใบ PJ ใหม่เข้าสัญญาจริง — bypass Guard B ด้วย GUC เดียวกับ transfer_contract_owner (0157 SECTION 3)
  -- + บันทึก audit ยอดที่เทียบกัน (0158 SECTION 0 — ติ๊กรีวิว ORANGE #3)
  -- ---------------------------------------------------------------------
  perform set_config('app.transfer_rpc', '1', true);

  update public.contracts set inv_no = v_new_inv_no where id = v_t.contract_id;

  update public.contract_transfers set
    new_inv_no              = v_new_inv_no,
    cutover_at               = now(),
    cutover_pj_total         = v_p.total,
    cutover_our_total        = v_our_total,
    cutover_matched          = v_matched,
    cutover_override_reason  = case when not v_matched then btrim(p_override_reason) else null end,
    cutover_by               = auth.uid(),
    cutover_by_name          = v_by_name
  where id = p_transfer_id;

  -- 🔒 hardening (ติ๊กรีวิว 2026-09-14) — เคลียร์ GUC ทันทีหลัง UPDATE ที่ต้อง bypass เสร็จ (set_config(...,true)
  -- เป็น transaction-local ไม่ใช่ function-local — กัน statement ถัดไปในทรานแซกชันเดียวกันหลุด Guard B โดยไม่ตั้งใจ)
  perform set_config('app.transfer_rpc', '', true);

  -- ---------------------------------------------------------------------
  -- ปิดกล่องรอตรวจ PJ ที่ค้างอยู่ใต้ INV ใหม่ — เฉพาะแถวที่ "ทุก element ใน raw_json มี uuid ครบ" และ uuid
  -- ทุกตัวถูก ignore หมดแล้ว (แปลว่าทั้งก้อนเป็นใบเดิมของคนเก่าที่ร้านคีย์ย้ายมา ไม่ใช่เงินใหม่จริง)
  -- (YELLOW fix #5, ติ๊กรีวิว 2026-09-14) — ถ้ามี element ไหนใน raw_json ไม่มี "uuid" เลยแม้แต่ตัวเดียว
  -- (total_elems <> uuid_elems) ห้าม skip แถวนั้นเด็ดขาด เพราะไม่มีทางพิสูจน์ว่า element ที่ไม่มี uuid นั้น
  -- ไม่ใช่เงินใหม่จริง — ปล่อย pending ให้คนตรวจต่อดีกว่าเงียบหาย ไม่แตะแถว RECEIPT_MISSING/RECEIPT_CHANGED
  -- (มี pj_receipt_uuid คอลัมน์ตรงอยู่แล้ว ไม่เกี่ยวกับ raw_json shape นี้)
  -- ---------------------------------------------------------------------
  with candidate as (
    select r.id,
           count(elem.*) as total_elems,
           count(elem.*) filter (where elem ->> 'uuid' is not null) as uuid_elems,
           coalesce(jsonb_agg(elem ->> 'uuid') filter (where elem ->> 'uuid' is not null), '[]'::jsonb) as uuids
    from public.pj_sync_review r
    left join jsonb_array_elements(coalesce(r.raw_json, '[]'::jsonb)) elem on true
    where public.sanitize_inv_no(r.pj_invoice_no) = v_new_inv_no
      and r.status = 'pending'
      and r.reason not in ('RECEIPT_MISSING', 'RECEIPT_CHANGED')
    group by r.id
  )
  update public.pj_sync_review r
  set status = 'skipped',
      resolved_by = v_by_name,
      resolved_at = now(),
      resolution_note = 'เปลี่ยนผู้ผ่อน — ใบเสร็จทั้งหมดเป็นของก่อน cutover (transfer_id ' || p_transfer_id || ') ไม่ต้องแจ้งเตือน'
  from candidate c
  where r.id = c.id
    and c.total_elems > 0
    and c.total_elems = c.uuid_elems
    and not exists (
      select 1 from jsonb_array_elements_text(c.uuids) u
      where u not in (select pj_receipt_uuid from public.pj_receipt_ignores where transfer_id = p_transfer_id)
    );

  -- ---------------------------------------------------------------------
  -- (ข) กัน reconcile (0114) แจ้งเตือน "ใบหาย" ของ INV เก่า หลัง cutover — pre-insert skipped ไว้ก่อน
  -- (on conflict do nothing กับ partial unique index ของ 0114:58-60 — ถ้า reconcile เคยรายงานไปแล้วก่อนหน้านี้
  -- จะไม่ทับของเดิม แต่ถ้ายังไม่เคยรายงาน แถวนี้จะ "silence" ไว้ล่วงหน้า ไม่ต้องรอ missing_streak ครบ 2 รอบ)
  -- ---------------------------------------------------------------------
  insert into public.pj_sync_review (
    pj_invoice_no, pj_payment_type, pj_amount, pj_paid_date,
    matched_contract_id, reason, raw_json, status, pj_receipt_uuid,
    resolved_by, resolved_at, resolution_note
  )
  select
    coalesce(pr.pj_invoice_no, pr.pj_receipt_uuid), pr.payment_type, pr.amount, pr.pj_paid_date,
    pr.contract_id, 'RECEIPT_MISSING',
    jsonb_build_object(
      'kind', 'missing', 'checkedAt', now(), 'missingStreak', 0,
      'ours', jsonb_build_object('amount', pr.amount, 'paymentType', pr.payment_type,
                                  'pjPaidDate', to_char(pr.pj_paid_date, 'YYYY-MM-DD')),
      'pj', null
    ),
    'skipped', pr.pj_receipt_uuid,
    v_by_name, now(),
    'เปลี่ยนผู้ผ่อน — ใบเสร็จเดิมของ INV เก่า (' || coalesce(v_t.old_inv_no, '-') || ') คาดว่าจะหายจาก PJ หลัง cutover (transfer_id ' || p_transfer_id || ') ไม่ต้องแจ้งเตือน'
  from public.pj_applied_receipts pr
  where pr.contract_id = v_t.contract_id
    and v_t.old_inv_no is not null
    and public.sanitize_inv_no(pr.pj_invoice_no) = public.sanitize_inv_no(v_t.old_inv_no)
  on conflict (pj_receipt_uuid) where reason in ('RECEIPT_MISSING', 'RECEIPT_CHANGED') do nothing;

  -- แคช PJ ของสัญญานี้ (ถ้ามี) ล้าง — ผูกใบใหม่แล้ว ค่าที่เคย fetch มาเทียบกับ INV เก่าไม่มีความหมายอีกต่อไป
  delete from public.pj_contract_snapshot where contract_id = v_t.contract_id;

  return jsonb_build_object(
    'transfer_id', p_transfer_id,
    'inv_no', v_new_inv_no,
    'matched', v_matched,
    'our_total', v_our_total,
    'pj_total', v_p.total
  );
end;
$$;

grant execute on function public.cutover_transfer_invoice(uuid, uuid, text, text) to authenticated, service_role;

comment on function public.cutover_transfer_invoice(uuid, uuid, text, text) is
  '(0158) admin/staff (active) ผูกเลขที่ใบ PJ ใหม่เข้า contracts.inv_no จริง — signature (p_transfer_id, p_precheck_id, p_new_inv_no default null, p_override_reason default null); p_new_inv_no ให้ตั้ง/แก้ transfers.new_inv_no ได้ตอน cutover เลยถ้ายังไม่เคย cutover; ต้องมี pj_invoice_prechecks อายุ<=30 นาที เลขที่ใบตรงกัน (normalize ด้วย sanitize_inv_no ทั้งสองฝั่ง); เทียบยอด (ดาวน์+งวด+ค่าปรับ cancel-aware+รายได้อื่นๆ ยกเว้น category=ค่าเอกสาร) กับ precheck.total ถ้าไม่ตรง staff ทำต่อไม่ได้ ต้อง admin+เหตุผล; insert pj_receipt_ignores ทุก uuid, บันทึก audit cutover_pj_total/cutover_our_total/cutover_matched/cutover_override_reason/cutover_by/cutover_by_name, skip pj_sync_review pending ของ INV ใหม่เฉพาะที่ทุก element มี uuid ครบและ ignore ครบ, pre-insert RECEIPT_MISSING skipped ของ INV เก่า, ลบ pj_contract_snapshot; ห้ามแตะเงิน/installments/other_income เลย (แค่ผูกเลขที่ใบ)';


-- ============================================================================
-- SECTION 4: create or replace undo_contract_transfer — เพิ่มเคส cutover (คืนเลข INV เดิม + ลบ ignore ของ transfer นี้)
-- ทับเวอร์ชันฐานของ 0157 ทั้งฟังก์ชัน (logic เดิมของ 0157 คงอยู่ครบ แค่แทรกเคส cutover_at is not null เพิ่ม)
-- ============================================================================
create or replace function public.undo_contract_transfer(
  p_transfer_id uuid,
  p_reason      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_t          contract_transfers%rowtype;
  v_latest_id  uuid;
  v_c          contracts%rowtype;
  v_by_name    text;
  v_addr_rec   record;
  v_drift      boolean;
begin
  if not is_admin() then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ยกเลิกการเปลี่ยนผู้ผ่อนได้';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ต้องระบุเหตุผลในการยกเลิก';
  end if;

  select * into v_t from public.contract_transfers where id = p_transfer_id for update;
  if not found then
    raise exception 'ไม่พบรายการเปลี่ยนผู้ผ่อนนี้: %', p_transfer_id;
  end if;

  if v_t.reversed_at is not null then
    raise exception 'รายการนี้ถูกยกเลิกไปแล้วเมื่อ %', v_t.reversed_at;
  end if;

  select id into v_latest_id
    from public.contract_transfers
   where contract_id = v_t.contract_id
   order by transfer_no desc
   limit 1;

  if v_latest_id is distinct from p_transfer_id then
    raise exception 'ยกเลิกได้เฉพาะรายการเปลี่ยนผู้ผ่อนครั้งล่าสุดของสัญญานี้เท่านั้น';
  end if;

  select * into v_c from public.contracts where id = v_t.contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญานี้';
  end if;

  if v_c.customer_name    is distinct from v_t.new_customer_name
  or v_c.national_id       is distinct from v_t.new_national_id
  or v_c.phone             is distinct from v_t.new_phone
  or v_c.phone_alt1        is distinct from v_t.new_phone_alt1
  or v_c.phone_alt2        is distinct from v_t.new_phone_alt2
  or v_c.birth_year        is distinct from v_t.new_birth_year
  or v_c.occupation        is distinct from v_t.new_occupation
  or v_c.occupation_proof  is distinct from v_t.new_occupation_proof
  or v_c.facebook_link     is distinct from v_t.new_facebook_link
  then
    raise exception 'ข้อมูลบนสัญญาถูกแก้ไขหลังเปลี่ยนผู้ผ่อนไปแล้ว ยกเลิกอัตโนมัติไม่ได้ กรุณาแก้ไขมือ';
  end if;

  -- 🆕 0158: เคส cutover แล้ว — เลข INV ปัจจุบันต้องยังตรงกับ new_inv_no ที่ transfer นี้ผูกไว้ (ไม่มีใครแก้ทับ)
  if v_t.cutover_at is not null and v_c.inv_no is distinct from v_t.new_inv_no then
    raise exception 'เลขที่ใบ PJ บนสัญญาถูกเปลี่ยนหลัง cutover ไปแล้ว ยกเลิกอัตโนมัติไม่ได้ กรุณาแก้ไขมือ';
  end if;

  select exists (
    select 1
    from jsonb_each(coalesce(v_t.new_addresses, '{}'::jsonb)) as na(kind, val)
    join public.customer_addresses ca
      on ca.contract_id = v_t.contract_id and ca.kind = na.kind
    where (na.val ->> 'houseNo')     is distinct from ca.house_no
       or (na.val ->> 'moo')         is distinct from ca.moo
       or (na.val ->> 'soi')         is distinct from ca.soi
       or (na.val ->> 'road')        is distinct from ca.road
       or (na.val ->> 'subdistrict') is distinct from ca.subdistrict
       or (na.val ->> 'district')    is distinct from ca.district
       or (na.val ->> 'province')    is distinct from ca.province
       or (na.val ->> 'postalCode')  is distinct from ca.postal_code
  ) into v_drift;

  if v_drift then
    raise exception 'ที่อยู่บนสัญญาถูกแก้ไขหลังเปลี่ยนผู้ผ่อนไปแล้ว ยกเลิกอัตโนมัติไม่ได้ กรุณาแก้ไขมือ';
  end if;

  -- 🆕 0158: คืนเลขที่ใบ PJ เดิมได้เฉพาะตอนที่ยังว่าง (ไม่มีสัญญาอื่นชิงใช้เลขนั้นไปแล้วหลัง cutover)
  if v_t.cutover_at is not null and v_t.old_inv_no is not null
     and exists (select 1 from public.contracts where inv_no = v_t.old_inv_no and id <> v_t.contract_id)
  then
    raise exception 'เลขที่ใบ PJ เดิม (%) ถูกใช้กับสัญญาอื่นไปแล้ว คืนค่าอัตโนมัติไม่ได้ กรุณาแก้ไขมือ', v_t.old_inv_no;
  end if;

  select coalesce(nullif(full_name, ''), '') into v_by_name from public.profiles where id = auth.uid();

  perform set_config('app.transfer_rpc', '1', true);

  update public.contracts set
    customer_name        = v_t.old_customer_name,
    national_id          = v_t.old_national_id,
    phone                = v_t.old_phone,
    phone_alt1           = v_t.old_phone_alt1,
    phone_alt2           = v_t.old_phone_alt2,
    birth_year           = v_t.old_birth_year,
    occupation           = v_t.old_occupation,
    occupation_proof     = v_t.old_occupation_proof,
    facebook_link        = v_t.old_facebook_link,
    dnc                  = v_t.old_dnc,
    dnc_reason           = v_t.old_dnc_reason,
    promise_to_pay_date  = v_t.old_promise_to_pay_date,
    -- 🆕 0158: คืนเลข INV เดิมเฉพาะตอน cutover แล้วเท่านั้น (ไม่งั้นคง inv_no ปัจจุบันไว้เหมือน 0157 เดิม)
    inv_no               = case when v_t.cutover_at is not null then v_t.old_inv_no else v_c.inv_no end
  where id = v_t.contract_id;

  -- 🔒 hardening (ติ๊กรีวิว 2026-09-14) — เคลียร์ GUC ทันทีหลัง UPDATE ที่ต้อง bypass เสร็จ (เหตุผลเดียวกับ
  -- transfer_contract_owner/cutover_transfer_invoice — set_config(...,true) เป็น transaction-local)
  perform set_config('app.transfer_rpc', '', true);

  for v_addr_rec in select key, value from jsonb_each(coalesce(v_t.old_addresses, '{}'::jsonb))
  loop
    insert into public.customer_addresses (
      contract_id, kind, house_no, moo, soi, road, subdistrict, district, province, postal_code, updated_at
    ) values (
      v_t.contract_id, v_addr_rec.key,
      nullif(v_addr_rec.value ->> 'houseNo', ''), nullif(v_addr_rec.value ->> 'moo', ''), nullif(v_addr_rec.value ->> 'soi', ''),
      nullif(v_addr_rec.value ->> 'road', ''), nullif(v_addr_rec.value ->> 'subdistrict', ''), nullif(v_addr_rec.value ->> 'district', ''),
      nullif(v_addr_rec.value ->> 'province', ''), nullif(v_addr_rec.value ->> 'postalCode', ''), now()
    )
    on conflict (contract_id, kind) do update set
      house_no = excluded.house_no, moo = excluded.moo, soi = excluded.soi, road = excluded.road,
      subdistrict = excluded.subdistrict, district = excluded.district, province = excluded.province,
      postal_code = excluded.postal_code, updated_at = excluded.updated_at;
  end loop;

  -- 🆕 0158: ลบ ignore ของ transfer นี้เท่านั้น (ไม่แตะ drift-suppression rows อื่น — เจตนา Pete: คงของเดิมไว้)
  delete from public.pj_receipt_ignores where transfer_id = p_transfer_id;

  update public.contract_transfers set
    reversed_at      = now(),
    reversed_by      = auth.uid(),
    reversed_by_name = v_by_name,
    reversed_reason  = btrim(p_reason),
    cutover_at       = null
  where id = p_transfer_id;
end;
$$;

grant execute on function public.undo_contract_transfer(uuid, text) to authenticated, service_role;

comment on function public.undo_contract_transfer(uuid, text) is
  '(0157+0158) admin เท่านั้น ยกเลิกรายการเปลี่ยนผู้ผ่อนล่าสุดของสัญญา — reason บังคับ; refuse ถ้าข้อมูล/ที่อยู่บนสัญญาถูกแก้ทับหลัง transfer หรือ (กรณี cutover แล้ว) เลข INV ถูกเปลี่ยน/เลข INV เดิมถูกสัญญาอื่นใช้ไปแล้ว; คืน old_* ทั้งหมด+ที่อยู่+เลข INV เดิม (ถ้า cutover แล้ว), ลบ pj_receipt_ignores เฉพาะของ transfer นี้ (คง drift-suppression rows เดิมไว้ตามเจตนา Pete) ไม่แตะเงิน/installments/other_income';


-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) ตารางใหม่ครบ 2 ตัว:
-- select table_name from information_schema.tables
--  where table_schema='public' and table_name in ('pj_invoice_prechecks','pj_receipt_ignores');
-- expected: 2 rows

-- b) service_role มีสิทธิ์ครบบนตารางใหม่ (Edge Function pj-snapshot/pj-sync จะพังถ้าไม่ผ่าน):
-- select has_table_privilege('service_role', 'public.pj_invoice_prechecks', 'INSERT'); -- true
-- select has_table_privilege('service_role', 'public.pj_receipt_ignores', 'SELECT');   -- true

-- c) authenticated: select ได้ แต่ insert ไม่ได้ (เขียนผ่าน service_role/RPC เท่านั้น):
-- select has_table_privilege('authenticated', 'public.pj_invoice_prechecks', 'SELECT'); -- true
-- select has_table_privilege('authenticated', 'public.pj_invoice_prechecks', 'INSERT'); -- false
-- select has_table_privilege('authenticated', 'public.pj_receipt_ignores', 'INSERT');   -- false

-- d) RPC ใหม่ + undo เวอร์ชันใหม่ authenticated เรียกได้ (signature ใหม่ 4-arg — ติ๊กรีวิว RED #2):
-- select has_function_privilege('authenticated', 'public.cutover_transfer_invoice(uuid,uuid,text,text)', 'EXECUTE'); -- true
-- select routine_name from information_schema.routines where routine_schema='public' and routine_name='undo_contract_transfer';
-- -- expected: 1 row (create or replace ทับของเดิม ไม่ใช่ overload ใหม่ — signature (uuid,text) เท่าเดิมเป๊ะ)

-- d2) cutover_transfer_invoice เหลือ signature เดียว (uuid,uuid,text,text) ไม่มี 3-arg เดิมตกค้าง
--    (pattern เดียวกับ 0100 SECTION 2 — DROP ก่อน CREATE ทำงานจริง):
-- select p.pronargs, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p where p.proname='cutover_transfer_invoice' and p.pronamespace='public'::regnamespace;
-- expected: 1 row เท่านั้น = (uuid, uuid, text, text)

-- e) undo_contract_transfer เหลือ signature เดียว (uuid, text) ไม่มีตัวซ้ำ (pattern เดียวกับ 0100 SECTION 2):
-- select p.pronargs, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p where p.proname='undo_contract_transfer' and p.pronamespace='public'::regnamespace;
-- expected: 1 row เท่านั้น = (uuid, text)

-- f) pj_sync_review dedup index (0114) ยังอยู่ ไม่ถูกแตะ:
-- select indexname from pg_indexes where indexname='pj_sync_review_drift_uuid_uidx';

-- g) เช็คคอลัมน์ audit cutover ครบ (ORANGE #3):
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='contract_transfers'
--    and column_name like 'cutover_%' order by column_name;
-- expected: cutover_at, cutover_by, cutover_by_name, cutover_matched, cutover_our_total,
--   cutover_override_reason, cutover_pj_total (7 แถว)

-- h) pj_sync_review.reason ไม่มี check constraint (ติ๊กรีวิวเช็คแล้ว — ค้นทุก migration ไม่เจอเลย, เป็น text
--    ธรรมดา) → 'TRANSFER_CUTOVER'/'OLD_INV_AFTER_TRANSFER' ที่น้องชีสอีกตัวจะใช้ใน pj-sync ใส่ได้เลยไม่ต้อง
--    migration แก้ constraint เพิ่ม — verify เผื่อไว้ (คาดหวัง 0 แถว = ไม่มี constraint):
-- select conname from pg_constraint
--  where conrelid = 'public.pj_sync_review'::regclass and pg_get_constraintdef(oid) ilike '%reason%';
