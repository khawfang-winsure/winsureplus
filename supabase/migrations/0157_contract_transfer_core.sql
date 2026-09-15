-- 0157: ฟีเจอร์ "เปลี่ยนผู้ผ่อน" (transfer owner) — ตัวหลัก
-- ────────────────────────────────────────────────────────────────────────────
-- บริบท: สัญญาแถวเดิม (ไม่สร้างสัญญาใหม่) เปลี่ยนแค่ตัวตนผู้ผ่อน — ร้านไม่ได้คอมมิชชั่น/โอนเงินเพิ่ม
-- (ห้ามแตะ device_price/down_percent/commission_percent/doc_fee/commission_*/net_transfer/summary_*)
-- ยอดค้าง/ค่าปรับ/ตารางงวดเดิมกลายเป็นภาระผู้ผ่อนคนใหม่ทันที — ไม่แตะ installments/payment_log/other_income
-- ที่มีอยู่เดิมเลย (ค่าธรรมเนียมปรับโครงสร้าง 500 บาท ลงเป็นรายได้อื่นๆ แยกต่างหาก ไม่ได้อยู่ใน migration นี้ —
-- fee-reconcile banner จะเตือนให้ลงเอง เหมือน extension fee)
--
-- คุณเตยเคาะแล้ว (locked 2026-09-14 — ดู scratchpad transfer-owner-brief.md):
--   1) staff+admin กดได้ (ไม่ใช่ freelance/accounting), เฉพาะสัญญา status='active'
--   2) DNC รีเซ็ตเป็น false/null (เป็นภาระของคนเดิม) — lawyer_engaged/disputed/assigned_to ไม่แตะ
--   3) promise_to_pay_date รีเซ็ต null (เป็นคำสัญญาของคนเดิม)
--   4) undo = admin เท่านั้น, ต้องมีเหตุผล, ยกเลิกได้เฉพาะรายการล่าสุดของสัญญา
--   5) ไม่จำกัดจำนวนครั้ง — เก็บเลข "ครั้งที่ N" ต่อสัญญา
--   6) เลขที่ใบ PJ ใหม่ (new_inv_no) ผูกได้ทีหลังผ่าน cutover_transfer_invoice (0158) — ไม่ set inv_no ที่นี่
--
-- กับดักที่ต้องระวัง (พี่ดิว recon):
--   - Guard B (contracts_review_guard, 0153) เทียบ auth.uid() ตรงๆ ใน trigger — SECURITY DEFINER ของ RPC
--     ไม่ได้ยกเว้นอัตโนมัติ ต้อง copy ฟังก์ชันจาก 0153 มาตรงตัวอักษร แล้วเพิ่ม GUC bypass 1 จุด (ดู SECTION 3)
--   - trg_prevent_staff_unflag (0019) กัน staff ปลด dnc — ต้อง copy มาตรงตัวอักษร แล้วเพิ่ม GUC bypass
--     เฉพาะ dnc (ไม่แตะ lawyer_engaged/disputed — ยังล็อกเหมือนเดิมทุกประการ, SECTION 4)
--   - GUC ใช้ชื่อเดียวกันทั้ง 0157/0158: app.transfer_rpc (pattern เดียวกับ app.review_rpc ของ Guard A)
--
-- Additive/idempotent — create or replace function (คงชื่อ/trigger เดิม), drop trigger if exists ก่อนสร้างใหม่,
-- add column if not exists, drop constraint if exists ก่อน add ใหม่ — ไม่ลบ/ไม่ rewrite ตารางเดิม

-- ============================================================================
-- SECTION 1: ตาราง contract_transfers — snapshot คนเดิม/คนใหม่ทุกครั้งที่เปลี่ยนผู้ผ่อน (audit เต็ม)
-- ============================================================================

create table if not exists public.contract_transfers (
  id                       uuid primary key default gen_random_uuid(),
  contract_id              uuid not null references public.contracts (id) on delete cascade,
  transfer_no              int not null,                    -- "ครั้งที่ N" ต่อสัญญา (ไม่รีเซ็ตตอน undo)
  effective_at             timestamptz not null default now(),

  -- ตัวตนผู้ผ่อน (เดิม → ใหม่) — ตรงกับคอลัมน์ contracts ที่ถูกเขียนทับใน transfer_contract_owner
  old_customer_name        text,
  new_customer_name        text,
  old_national_id          text,
  new_national_id          text,
  old_phone                text,
  new_phone                text,
  old_phone_alt1           text,
  new_phone_alt1           text,
  old_phone_alt2           text,
  new_phone_alt2           text,
  old_birth_year            int,
  new_birth_year            int,
  old_occupation            text,
  new_occupation            text,
  old_occupation_proof      text,
  new_occupation_proof      text,
  old_facebook_link         text,
  new_facebook_link         text,

  -- compliance/servicing ที่รีเซ็ตตอนเปลี่ยนผู้ผ่อน (เป็นภาระ/ข้อมูลของ "คนเดิม")
  old_dnc                   boolean,
  new_dnc                   boolean,
  old_dnc_reason            text,
  new_dnc_reason            text,
  old_promise_to_pay_date   date,
  new_promise_to_pay_date   date,

  -- ที่อยู่ทั้งชุด (current/id_card/work/registry) — เก็บเป็น jsonb camelCase ตรงกับ CustomerAddress
  -- (src/lib/types.ts) key ต่อ kind เช่น {"current": {"houseNo":"12","moo":"3",...}, "id_card": {...}}
  old_addresses             jsonb,
  new_addresses             jsonb,

  -- เลขที่ใบ PJ — new_inv_no ผูกจริงเข้า contracts.inv_no ทีหลังผ่าน cutover_transfer_invoice (0158) เท่านั้น
  old_inv_no                text,
  new_inv_no                text,
  cutover_at                timestamptz,                     -- null = ยังไม่ผูกเลขที่ใบใหม่จริง

  note                      text,

  -- ผู้ทำรายการ — ประทับตราอัตโนมัติผ่าน trigger ด้านล่าง (ปลอมไม่ได้ เหมือน set_extension_recorder 0013)
  created_by                uuid references public.profiles (id),
  created_by_name           text,
  created_at                timestamptz not null default now(),

  -- ยกเลิก (undo) — admin เท่านั้น เหตุผลบังคับ (ดู RPC undo_contract_transfer)
  reversed_at               timestamptz,
  reversed_by               uuid references public.profiles (id),
  reversed_by_name          text,
  reversed_reason           text,

  unique (contract_id, transfer_no)
);

create index if not exists contract_transfers_contract_idx
  on public.contract_transfers (contract_id, transfer_no desc);

comment on table public.contract_transfers is
  '(0157) ประวัติเต็มของการเปลี่ยนผู้ผ่อนต่อสัญญา (snapshot คนเดิม+คนใหม่+ที่อยู่+เลขที่ใบ PJ ทุกครั้ง) — เขียนได้ทาง RPC transfer_contract_owner/undo_contract_transfer/cutover_transfer_invoice (SECURITY DEFINER) เท่านั้น ไม่มี PII freelancer เห็น (staff/admin/accounting เท่านั้น)';

-- ประทับตรา "ใครทำรายการ" อัตโนมัติ (ปลอมไม่ได้) — mirror set_extension_recorder (0013) ตรงตัว
create or replace function public.set_contract_transfer_recorder()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  if new.created_by_name is null then
    new.created_by_name := (
      select coalesce(nullif(p.full_name, ''), u.email, '')
      from auth.users u
      left join public.profiles p on p.id = u.id
      where u.id = new.created_by
    );
  end if;
  return new;
end;
$$;

drop trigger if exists contract_transfers_set_recorder on public.contract_transfers;
create trigger contract_transfers_set_recorder
  before insert on public.contract_transfers
  for each row execute function public.set_contract_transfer_recorder();

-- RLS: select admin/staff/accounting (ไม่ใช่ freelance — มี PII เดิม/ใหม่เต็ม) เขียนผ่าน RPC เท่านั้น
alter table public.contract_transfers enable row level security;

drop policy if exists contract_transfers_select on public.contract_transfers;
create policy contract_transfers_select on public.contract_transfers
  for select to authenticated
  using (is_admin() or is_staff() or is_accounting());

-- authenticated: SELECT เท่านั้น (insert/update ทำผ่าน RPC SECURITY DEFINER ด้านล่าง ข้าม RLS/grant นี้อยู่แล้ว)
grant select on public.contract_transfers to authenticated;

-- service_role: full (0017 ALTER DEFAULT PRIVILEGES ครอบให้แล้ว แต่ใส่ชัดๆ ไว้ด้วยตาม pattern โปรเจกต์)
grant select, insert, update, delete on public.contract_transfers to service_role;


-- ============================================================================
-- SECTION 2: fee_waivers + other_income.fee_kind — เพิ่มสิทธิ์ 'transfer' (ค่าธรรมเนียมปรับโครงสร้าง)
-- ต่างจาก due_day/months/settle ตรงที่ "ยกเว้นได้ต่อครั้ง" (ทุกรอบ transfer มีสิทธิ์ของตัวเอง)
-- ไม่ใช่ "ยกเว้นได้ครั้งเดียวตลอดสัญญา" — ต้องผูกกับ transfer_id ไม่ใช่แค่ contract_id
-- ============================================================================

alter table public.other_income
  drop constraint if exists other_income_fee_kind_chk;
alter table public.other_income
  add constraint other_income_fee_kind_chk
  check (fee_kind is null or fee_kind in ('due_day', 'months', 'both', 'settle', 'transfer'));

alter table public.fee_waivers
  drop constraint if exists fee_waivers_fee_right_check;
alter table public.fee_waivers
  add constraint fee_waivers_fee_right_check
  check (fee_right in ('due_day', 'months', 'settle', 'transfer'));

alter table public.fee_waivers
  add column if not exists transfer_id uuid references public.contract_transfers (id) on delete cascade;

alter table public.fee_waivers
  drop constraint if exists fee_waivers_transfer_id_chk;
alter table public.fee_waivers
  add constraint fee_waivers_transfer_id_chk
  check (
    (fee_right = 'transfer' and transfer_id is not null)
    or (fee_right <> 'transfer' and transfer_id is null)
  );

-- เดิม unique(contract_id, fee_right) กันยกเว้นซ้ำ — 'transfer' ต้องยกเว้นได้ "ต่อรอบ" ไม่ใช่ครั้งเดียวตลอดสัญญา
-- → drop unique เดิม แยกเป็น partial unique 2 ตัว: due_day/months/settle ยังกันซ้ำแบบเดิมเป๊ะ (1 ครั้ง/สัญญา),
-- transfer กันซ้ำต่อรอบ (1 ครั้ง/transfer_id) — ไม่พังโค้ดเดิมที่ insert ตรงๆ (db.ts waiveFee ไม่ได้ upsert
-- ด้วย onConflict อยู่แล้ว พึ่ง error 23505 จาก unique constraint ให้ UI กันซ้ำ — ยังทำงานเหมือนเดิมทุกประการ
-- สำหรับ 3 สิทธิ์เก่า)
alter table public.fee_waivers
  drop constraint if exists fee_waivers_contract_id_fee_right_key;

drop index if exists public.fee_waivers_contract_fee_right_uidx;
create unique index fee_waivers_contract_fee_right_uidx
  on public.fee_waivers (contract_id, fee_right)
  where fee_right <> 'transfer';

drop index if exists public.fee_waivers_contract_transfer_uidx;
create unique index fee_waivers_contract_transfer_uidx
  on public.fee_waivers (contract_id, transfer_id)
  where fee_right = 'transfer';


-- ============================================================================
-- SECTION 3: contracts_review_guard() — copy จาก 0153 ตรงตัวอักษร + เพิ่ม GUC bypass 1 จุดใน Guard B
-- (เปลี่ยนเฉพาะเงื่อนไข if ของ Guard B — Guard A/C/D และ comment เดิมคงเดิมทุกตัวอักษร)
-- ============================================================================

create or replace function public.contracts_review_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate_from text;
begin
  -- ยกเว้น service_role ทั้งหมด (Edge Function send-company-email ต้อง stamp
  -- email_sent_at/email_sent_by บนสัญญา approved ได้ผ่าน service-role client — ดู 0142/send-company-email)
  -- เช็ค 2 ทาง: current_user (role ที่ต่อ DB จริงตอนใช้ SUPABASE_SERVICE_ROLE_KEY ผ่าน PostgREST)
  -- และ request.jwt.claim.role (GUC ที่ PostgREST/Data API ตั้งจาก JWT role claim) — กันพลาดถ้าฝั่งใดฝั่งหนึ่ง
  -- ไม่ตรงตามที่คาด (เช่น ต่อผ่าน connection pooler ที่ตั้ง role คนละแบบ)
  if current_user = 'service_role'
     or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  then
    return new;
  end if;

  -- ยกเว้นทุก request ที่ไม่มี user login (auth.uid() เป็น null) — ครอบคลุม service_role (กันซ้ำจากเช็คด้านบน),
  -- เจ้าของ table (migration/MCP ที่รันเป็น Postgres owner ไม่ใช่ service_role), และ cron/Edge context อื่นๆ
  -- เหตุผล: browser client ของ staff/admin ทุกตัวแนบ JWT เสมอ ดังนั้น auth.uid() ต้อง non-null ทุก request
  -- จากฝั่ง staff จริง — null คือไม่ใช่ threat model ของ guard นี้ (staff เข้าตาราง contracts ไม่ได้เลยถ้าไม่มี JWT
  -- เพราะ RLS policy เดิมของ contracts เองก็ require is_admin()/is_staff() ซึ่ง lookup profiles ผ่าน auth.uid())
  -- ผลคือ: manual SQL fix ที่ครีม/ติ๊กรันผ่าน apply_migration MCP (เป็น owner ไม่ใช่ service_role) แก้คอลัมน์อื่น
  -- ของสัญญา approved แล้วได้ตามปกติ ไม่โดน Guard B บล็อกอีกต่อไป
  if auth.uid() is null then
    return new;
  end if;

  -- Guard A: review_status / review_updated_at / review_updated_by เปลี่ยนได้ทาง RPC เท่านั้น
  -- RPC ทั้ง 3 ตัว (0142) ตั้ง app.review_rpc='1' แบบ transaction-local ก่อน update ทุกครั้ง (SECTION 2)
  if (new.review_status is distinct from old.review_status)
     or (new.review_updated_at is distinct from old.review_updated_at)
     or (new.review_updated_by is distinct from old.review_updated_by)
  then
    if coalesce(current_setting('app.review_rpc', true), '') <> '1' then
      raise exception 'สถานะการตรวจเปลี่ยนได้ผ่านปุ่มในระบบเท่านั้น';
    end if;
  end if;

  -- Guard B (0153 — deny-list แทน allow-list เดิม): เคส approved แล้ว — staff (ไม่ใช่แอดมิน) แก้ "เนื้อหาสัญญา"
  -- ที่อยู่ในแผงตรวจ + ฟอร์มแก้ไขสัญญาเต็มรูป (toUpdate() ใน db.ts) ไม่ได้ ส่วนคอลัมน์อื่นทั้งหมด (workflow/
  -- lifecycle/compliance/servicing) ไม่ถูกเทียบเลย = แก้ได้ปกติไม่ว่า review_status จะเป็นอะไร
  -- รายละเอียด "ทำไมล็อก/ทำไมปล่อย" รายฟิลด์ — ดู comment หัวไฟล์นี้ + ตารางในข้อความที่ส่งคุณเตย/ครีม
  -- (สรุปสั้น: ล็อกเฉพาะตัวตนลูกค้า/เครื่อง/ราคาตั้งต้น/ร้าน/โปร/ผู้ทำรายการที่กรอกตอนเปิดสัญญา — ปล่อย
  -- ทุกอย่างที่เป็นการทำงานต่อเนื่องหลังอนุมัติ รวมถึง finance_amount/monthly_payment/term_months/due_day
  -- ที่ restructure_contract (ปุ่ม "ขยายระยะเวลา") ต้องแก้ได้แม้ approved แล้ว)
  --
  -- 🆕 0157: เพิ่ม GUC bypass 1 จุด (app.transfer_rpc='1') — transfer_contract_owner/cutover_transfer_invoice
  -- ต้องแก้ customer_name/national_id/phone*/facebook_link/birth_year/occupation/occupation_proof/inv_no
  -- บนสัญญา approved แล้วได้ (เปลี่ยนผู้ผ่อนไม่ผูกกับสถานะตรวจ) — GUC ตั้งแบบ transaction-local เฉพาะใน RPC
  -- เหล่านั้นเท่านั้น (pattern เดียวกับ app.review_rpc/app.force_summary_rpc) ไม่กระทบ path อื่นเลย
  if old.review_status = 'approved' and not public.is_admin()
     and coalesce(current_setting('app.transfer_rpc', true), '') <> '1'
  then
    if new.contract_no        is distinct from old.contract_no
    or new.inv_no              is distinct from old.inv_no
    or new.sn                  is distinct from old.sn
    or new.imei                is distinct from old.imei
    or new.customer_name       is distinct from old.customer_name
    or new.national_id         is distinct from old.national_id
    or new.phone               is distinct from old.phone
    or new.phone_alt1          is distinct from old.phone_alt1
    or new.phone_alt2          is distinct from old.phone_alt2
    or new.facebook_link       is distinct from old.facebook_link
    or new.birth_year          is distinct from old.birth_year
    or new.occupation          is distinct from old.occupation
    or new.occupation_proof    is distinct from old.occupation_proof
    or new.shop_id             is distinct from old.shop_id
    or new.model               is distinct from old.model
    or new.storage             is distinct from old.storage
    or new.condition           is distinct from old.condition
    or new.origin               is distinct from old.origin
    or new.device_price        is distinct from old.device_price
    or new.color                is distinct from old.color
    or new.down_percent        is distinct from old.down_percent
    or new.commission_percent  is distinct from old.commission_percent
    or new.doc_fee              is distinct from old.doc_fee
    or new.has_promotion       is distinct from old.has_promotion
    or new.promotion            is distinct from old.promotion
    or new.promotion_detail    is distinct from old.promotion_detail
    or new.transaction_date    is distinct from old.transaction_date
    or new.operator              is distinct from old.operator
    or new.notes                 is distinct from old.notes
    or new.credit_history_found is distinct from old.credit_history_found
    then
      raise exception 'เคสนี้ตรวจผ่านแล้ว แก้ไขไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน';
    end if;
  end if;

  -- Guard C (0149): กัน stamp/re-stamp email_sent_at ตรงบนสัญญา post-cutoff ที่ยังไม่ approved —
  -- ปิดบั๊ก 3 สัญญาส่งเมลหลุด (ดู comment หัวไฟล์ 0149). predicate ครอบ NULL->non-NULL และ re-stamp
  -- (non-NULL->non-NULL ค่าใหม่) ด้วย — ช่องที่เปิดอยู่คือ: approved -> ส่งเมล (stamp email_sent_at) ->
  -- แอดมินกด reject_review -> review_status='needs_fix' (0142:327 ไม่ล้าง email_sent_at เดิม) -> ตอนนี้
  -- staff PATCH email_sent_at เป็นค่าใหม่ได้ (Guard B ไม่ยิงเพราะ old.review_status ไม่ใช่ 'approved'
  -- แล้ว) ถ้า predicate แคบแค่ NULL->non-NULL จะไม่ครอบเคสนี้
  --
  -- เจตนา: ยังให้แอดมินเคลียร์ email_sent_at กลับเป็น NULL ได้ตามปกติ (pendingDocuments ใน db.ts ล้างค่านี้
  -- เป็นส่วนหนึ่งของ flow เก่า) — Guard C เช็คเฉพาะทิศ "ตั้งค่า" ไม่เช็คทิศ "ล้างค่า"
  --
  -- ไม่ยกเว้น is_admin() และไม่ยกเว้นเมื่อมีแถวใน contract_media_gate_override โดยตั้งใจ — override (0137)
  -- แปลว่า "รูปไม่ครบแต่ให้ผ่านเกทรูป" เท่านั้น ไม่ใช่ "ข้ามการตรวจของคุณเตย" (media_gate_complete ใน 0142
  -- SECTION 3 honor override นี้อยู่แล้วตอน submit_for_review จึงไม่มี deadlock ที่ชั้น DB — เคส bypass
  -- ยัง submit -> approve ได้ตามปกติ ไม่ต้องมีทางออกฉุกเฉินที่ Guard C)
  --
  -- ⚠️ กับดักฝั่ง client ที่ยังไม่ live (comment เตือนไว้ ไม่ใช่งานรอบนี้): ContractDetail.tsx ไม่เคยอ่าน
  -- contract_media_gate_override ตอนนี้ (0 แถวทั้งตาราง ณ วันที่เขียนไฟล์นี้) ปุ่ม "ส่งให้คุณเตยตรวจ" จะเทา
  -- ถ้ารูปไม่ครบแม้แอดมินกด override ไว้แล้ว — วันใดเริ่มมีแถว override จริง ต้องไปเพิ่มตัวอ่าน override
  -- ฝั่งฟรอนต์เอนด์ก่อน ไม่งั้นเคสนั้นจะส่งเมลไม่ได้ตลอดกาล (ผ่าน DB gate ได้ แต่เข้า pending_review ไม่ได้
  -- เพราะปุ่มเทา)
  if new.email_sent_at is not null
     and new.email_sent_at is distinct from old.email_sent_at
  then
    select value into v_gate_from from public.app_settings where key = 'media_gate_from';
    v_gate_from := coalesce(v_gate_from, '2026-09-09'); -- ต้องตรงกับ 0150:160 / db.ts:8807 / Edge index.ts:180 เป๊ะๆ

    if old.created_at is not null
       and (old.created_at at time zone 'utc')::date >= v_gate_from::date
       and old.review_status is distinct from 'approved'
    then
      raise exception 'เคสนี้ยังไม่ผ่านการตรวจ ส่งเมลไม่ได้ ให้กดปุ่มส่งให้คุณเตยตรวจที่หน้าสัญญาก่อน';
    end if;
  end if;

  -- Guard D (0151 — ใหม่): เคส post-cutoff ที่ยังไม่ approved ต้องกดสรุปยอดส่งร้าน (summary_shop_sent_at)
  -- ไม่ได้ — ปิดช่อง mark_summary_shop_sent (0105, SECURITY INVOKER, plain UPDATE ไม่มี guard เรื่องนี้)
  -- และ REST PATCH ตรงที่ RLS contracts_update (0095) อนุญาต staff กว้างๆ ไว้อยู่แล้ว
  --
  -- predicate ตั้งใจให้ทรง (shape) เดียวกับ Guard C ทุกประการ:
  --   - เช็คเฉพาะทิศ "ตั้งค่า" (new not null และต่างจาก old) — ทิศ "เคลียร์เป็น null" ไม่โดนบล็อก เพราะ
  --     rejectSummaryContract (db.ts:1003, บัญชีตีกลับเคส) และ bounce-back ของ pendingDocuments ต้อง
  --     เซ็ต summary_shop_sent_at กลับเป็น null ได้ปกติ ไม่งั้นฟีเจอร์เดิมพังเงียบ
  --   - gate ด้วย media_gate_from เทียบ created_at เหมือน Guard C — สัญญาเก่าก่อน cutoff ไม่โดนกฎนี้เลย
  --   - ไม่ยกเว้น is_admin() โดยตั้งใจ (เหมือน Guard C) — ทางออกเดียวที่ให้ผ่านคือ RPC ฉุกเฉิน
  --     force_mark_summary_shop_sent (SECTION 3 ของ 0151) ซึ่งตั้ง GUC ธุรกรรม-เดียว 'app.force_summary_rpc'
  --     ก่อน UPDATE (pattern เดียวกับ app.review_rpc ของ Guard A, 0143) — ไม่ปิด trigger ทั้งตัว
  --
  -- service_role และ auth.uid() is null ได้รับการยกเว้นแล้วจาก early-return ด้านบนของฟังก์ชันนี้ (ไม่ต้อง
  -- เขียนซ้ำใน Guard D) — Edge Fn / MCP / data fix จึงไม่โดน Guard D บล็อก
  if new.summary_shop_sent_at is not null
     and new.summary_shop_sent_at is distinct from old.summary_shop_sent_at
     and coalesce(current_setting('app.force_summary_rpc', true), '') <> '1'
  then
    select value into v_gate_from from public.app_settings where key = 'media_gate_from';
    v_gate_from := coalesce(v_gate_from, '2026-09-09'); -- ต้องตรงกับ 0150:160 / db.ts:8807 / Edge index.ts:180 เป๊ะๆ

    if old.created_at is not null
       and (old.created_at at time zone 'utc')::date >= v_gate_from::date
       and old.review_status is distinct from 'approved'
    then
      raise exception 'เคสนี้ยังไม่ผ่านการตรวจ จึงยังสรุปยอดไม่ได้ค่ะ';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.contracts_review_guard() is
  '(0143+0149+0150+0151+0153+0157) BEFORE UPDATE guard บน contracts: Guard A กัน review_status/review_updated_at/review_updated_by ถูกเขียนตรงนอก RPC 0142; Guard B (0153, deny-list) กัน staff แก้เฉพาะคอลัมน์เนื้อหาสัญญา (ตัวตนลูกค้า/เครื่อง/ราคาตั้งต้น/ร้าน/โปร/ผู้ทำรายการ/credit_history_found — ตรงกับ toUpdate() ใน db.ts) บนสัญญา approved แล้ว ปล่อยทุกคอลัมน์ workflow/lifecycle อื่น (รวม finance_amount/monthly_payment/term_months/due_day ที่ restructure_contract ต้องแก้ได้) ให้แก้ได้ปกติ — ยกเว้นเพิ่มเมื่อ app.transfer_rpc=1 (0157 transfer_contract_owner/cutover_transfer_invoice แก้ตัวตนผู้ผ่อน/inv_no ได้แม้ approved); Guard C (0149) กัน stamp/re-stamp email_sent_at บนสัญญา post-cutoff ที่ยังไม่ approved; Guard D (0151) กัน stamp summary_shop_sent_at บนสัญญา post-cutoff ที่ยังไม่ approved — ทางออกเดียวคือ RPC force_mark_summary_shop_sent — ยกเว้น service_role ทั้งหมด และยกเว้นทุก request ที่ auth.uid() เป็น null (owner/MCP/cron/Edge)';

drop trigger if exists contracts_review_guard on public.contracts;
create trigger contracts_review_guard
  before update on public.contracts
  for each row execute function public.contracts_review_guard();


-- ============================================================================
-- SECTION 4: prevent_staff_unflag() — copy จาก 0019 ตรงตัวอักษร + เพิ่ม GUC bypass เฉพาะ dnc
-- (lawyer_engaged/disputed ไม่แตะ — staff ยังปลดไม่ได้เหมือนเดิมทุกประการ แม้อยู่ระหว่าง transfer_rpc)
-- ============================================================================

create or replace function public.prevent_staff_unflag()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller_role text;
begin
  -- ถ้าเป็น admin → อนุญาตทุกอย่าง
  if is_admin() then return new; end if;

  select role into v_caller_role
  from public.profiles
  where id = auth.uid();

  -- staff ตั้งธงได้แต่ปลดไม่ได้
  if v_caller_role = 'staff' then
    -- dnc: true→false = ปลด → block (🆕 0157: ยกเว้นเมื่อ app.transfer_rpc='1' — transfer_contract_owner
    -- ต้องรีเซ็ต dnc เป็น false ให้ staff กดได้ด้วย เพราะ DNC เป็นภาระของ "คนเดิม" ไม่ใช่คนใหม่)
    if old.dnc = true and new.dnc = false
       and coalesce(current_setting('app.transfer_rpc', true), '') <> '1'
    then
      raise exception 'permission denied: only admin can unset dnc flag';
    end if;
    -- lawyer_engaged: true→false = ปลด → block
    if old.lawyer_engaged = true and new.lawyer_engaged = false then
      raise exception 'permission denied: only admin can unset lawyer_engaged flag';
    end if;
    -- disputed: true→false = ปลด → block (admin only ตาม decision #8 general rule)
    if old.disputed = true and new.disputed = false then
      raise exception 'permission denied: only admin can unset disputed flag';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_staff_unflag on public.contracts;
create trigger trg_prevent_staff_unflag
  before update on public.contracts
  for each row execute function public.prevent_staff_unflag();


-- ============================================================================
-- SECTION 4B: sanitize_inv_no() — mirror sanitizeInvNo() ใน src/lib/format.ts ตัวอักษรต่อตัวอักษร
-- (trim หัวท้าย -> เอา token แรกที่ไม่มีช่องว่าง -> เก็บเฉพาะ [A-Za-z0-9-] -> uppercase) ใช้จุดเดียวทั้ง
-- 0157 (transfer_contract_owner) และ 0158 (cutover_transfer_invoice) กันสอง SQL normalize ไม่ตรงกัน
-- (ติ๊กรีวิว YELLOW #4, 2026-09-14) — ถ้าวันหน้า format.ts แก้กติกา ต้องมา sync ฟังก์ชันนี้ด้วย
-- ============================================================================

create or replace function public.sanitize_inv_no(p_raw text)
returns text
language sql
immutable
set search_path = public, pg_catalog
as $$
  select nullif(
    upper(regexp_replace(substring(btrim(coalesce(p_raw, '')) from '^\S+'), '[^A-Za-z0-9-]', '', 'g')),
    ''
  );
$$;

grant execute on function public.sanitize_inv_no(text) to authenticated, service_role;

comment on function public.sanitize_inv_no(text) is
  '(0157) mirror sanitizeInvNo() (src/lib/format.ts) ฝั่ง SQL — trim, เอา token แรกก่อนช่องว่าง, ตัดอักขระนอก [A-Za-z0-9-], uppercase; คืน null ถ้าผลลัพธ์ว่าง ใช้ normalize เลขที่ใบ PJ ก่อนเทียบ/บันทึกทุกจุดใน 0157/0158';


-- ============================================================================
-- SECTION 5: RPC transfer_contract_owner — staff/admin กด "เปลี่ยนผู้ผ่อน"
-- ============================================================================
--
-- เช็คเอกสารแนบ (แก้ตามคำสั่งประสาน 2026-09-14 — reuse ชุด slot จาก checklist รอตรวจเมลเดิม เอกสารบุคคล
-- เท่านั้น ไม่มีรูปเครื่อง): เก็บเป็นค่าคงที่ "จุดเดียว" ในตัวแปร v_slot_spec ด้านล่าง (suffix, min) — 5 ช่อง
-- ปัจจุบัน (id_card_front/occupation_photo/contract_docs/id_copy_consent/credit_check — credit_check เพิ่ม
-- ทีหลังสุดตามที่คุณเตยเคาะ 2026-09-14 ไม่มีขั้นแอดมินตรวจแยก ไม่แตะ review_status) เพิ่มช่องใหม่ในอนาคต
-- แก้ตรงนี้จุดเดียวพอ ไม่ต้องแก้ที่อื่น — slot_key จริงบน contract_media = 'transfer_' || v_round || '_' || suffix (namespaced ต่อรอบ)
create or replace function public.transfer_contract_owner(
  p_contract_id  uuid,
  p_new          jsonb,
  p_addresses    jsonb,
  p_new_inv_no   text default null,
  p_note         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role                 text;
  v_active                boolean;
  v_by_name               text;
  v_c                     contracts%rowtype;
  v_round                 int;
  v_transfer_id           uuid;

  v_new_customer_name     text;
  v_new_national_id       text;
  v_new_phone              text;
  v_new_phone_alt1         text;
  v_new_phone_alt2         text;
  v_new_facebook           text;
  v_new_birth_year         int;
  v_new_occupation         text;
  v_new_occupation_proof   text;
  v_new_inv_no_norm        text;

  v_kind                  text;
  v_addr                  jsonb;
  v_old_addresses          jsonb;

  -- 🔑 จุดเดียวที่ต้องแก้ถ้าเพิ่ม/ลด/เปลี่ยน min ของช่องเอกสารเปลี่ยนผู้ผ่อน
  v_slot_spec jsonb := '[
    {"suffix":"id_card_front",     "min":1, "label":"บัตรประชาชนผู้ผ่อนคนใหม่"},
    {"suffix":"occupation_photo",  "min":1, "label":"รูปถ่ายประกอบอาชีพ"},
    {"suffix":"contract_docs",     "min":4, "label":"เอกสารสัญญาใหม่"},
    {"suffix":"id_copy_consent",   "min":1, "label":"สำเนาบัตร + หนังสือยินยอม"},
    {"suffix":"credit_check",      "min":1, "label":"ผลเช็คเครดิต"}
  ]'::jsonb;
  v_slot                  jsonb;
  v_slot_cnt               int;
  v_missing                text[] := '{}';
begin
  -- ---------------------------------------------------------------------
  -- SECURITY GUARD: admin/staff (active) เท่านั้น — คุณเตยล็อก ไม่ใช่ freelance/accounting
  -- ---------------------------------------------------------------------
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    raise exception 'ไม่มีสิทธิ์เปลี่ยนผู้ผ่อน';
  end if;

  select coalesce(nullif(full_name, ''), '') into v_by_name
    from public.profiles where id = auth.uid();

  if p_new is null then
    raise exception 'ข้อมูลผู้ผ่อนคนใหม่ห้ามว่าง';
  end if;

  -- ---------------------------------------------------------------------
  -- ล็อกแถวสัญญา + ต้อง active เท่านั้น
  -- ---------------------------------------------------------------------
  select * into v_c from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญานี้: %', p_contract_id;
  end if;
  if v_c.status is distinct from 'active' then
    raise exception 'เปลี่ยนผู้ผ่อนได้เฉพาะสัญญาที่ยัง active เท่านั้น (สถานะปัจจุบัน: %)', v_c.status;
  end if;

  -- เลข "ครั้งที่ N" ของสัญญานี้ (max+1 — ไม่รีเซ็ตตอน undo, กันชนถ้าวันหน้ามีแถวทดสอบถูกลบ)
  select coalesce(max(transfer_no), 0) + 1 into v_round
    from public.contract_transfers where contract_id = p_contract_id;

  -- ---------------------------------------------------------------------
  -- validate ข้อมูลผู้ผ่อนคนใหม่ (บาร์เดียวกับ AddContract ตาม brief — required ครบทุกช่อง)
  -- ---------------------------------------------------------------------
  v_new_customer_name    := nullif(btrim(p_new ->> 'customer_name'), '');
  v_new_national_id      := nullif(btrim(p_new ->> 'national_id'), '');
  v_new_phone             := nullif(btrim(p_new ->> 'phone'), '');
  v_new_phone_alt1         := nullif(btrim(p_new ->> 'phone_alt1'), '');
  v_new_phone_alt2         := nullif(btrim(p_new ->> 'phone_alt2'), '');
  v_new_facebook           := nullif(btrim(p_new ->> 'facebook_link'), '');
  v_new_birth_year         := nullif(btrim(p_new ->> 'birth_year'), '')::int;
  v_new_occupation         := nullif(btrim(p_new ->> 'occupation'), '');
  v_new_occupation_proof   := nullif(btrim(p_new ->> 'occupation_proof'), '');

  if v_new_customer_name is null then raise exception 'กรุณากรอกชื่อผู้ผ่อนคนใหม่'; end if;
  if v_new_national_id is null or v_new_national_id !~ '^[0-9]{13}$' then
    raise exception 'เลขบัตรประชาชนผู้ผ่อนคนใหม่ต้องเป็นตัวเลข 13 หลัก';
  end if;
  if v_new_national_id = v_c.national_id then
    raise exception 'เลขบัตรประชาชนผู้ผ่อนคนใหม่ซ้ำกับคนเดิม — ถ้าต้องการแก้ข้อมูลคนเดิม ให้ใช้หน้าแก้ไขสัญญาแทน';
  end if;
  if v_new_phone is null then raise exception 'กรุณากรอกเบอร์โทรผู้ผ่อนคนใหม่'; end if;
  if v_new_phone_alt1 is null then raise exception 'กรุณากรอกเบอร์โทรสำรอง 1 ของผู้ผ่อนคนใหม่'; end if;
  if v_new_phone_alt2 is null then raise exception 'กรุณากรอกเบอร์โทรสำรอง 2 ของผู้ผ่อนคนใหม่'; end if;
  if v_new_facebook is null then raise exception 'กรุณากรอกลิงก์เฟซบุ๊กผู้ผ่อนคนใหม่'; end if;
  if v_new_birth_year is null then raise exception 'กรุณากรอกปีเกิดผู้ผ่อนคนใหม่'; end if;
  if v_new_occupation is null then raise exception 'กรุณากรอกอาชีพผู้ผ่อนคนใหม่'; end if;
  if v_new_occupation_proof is null then raise exception 'กรุณากรอกหลักฐานอาชีพผู้ผ่อนคนใหม่'; end if;

  -- ที่อยู่ current/id_card/work บังคับ (registry ไม่บังคับ — ตาม brief)
  for v_kind in select unnest(array['current', 'id_card', 'work'])
  loop
    v_addr := p_addresses -> v_kind;
    if v_addr is null or jsonb_typeof(v_addr) <> 'object' then
      raise exception 'กรุณากรอกที่อยู่ (%) ของผู้ผ่อนคนใหม่', v_kind;
    end if;
    if coalesce(nullif(btrim(v_addr ->> 'houseNo'), ''), '') = ''
       or coalesce(nullif(btrim(v_addr ->> 'subdistrict'), ''), '') = ''
       or coalesce(nullif(btrim(v_addr ->> 'district'), ''), '') = ''
       or coalesce(nullif(btrim(v_addr ->> 'province'), ''), '') = ''
    then
      raise exception 'กรุณากรอกที่อยู่ (%) ให้ครบ (บ้านเลขที่/ตำบล/อำเภอ/จังหวัด)', v_kind;
    end if;
  end loop;

  -- new_inv_no ไม่บังคับตอนเปลี่ยนผู้ผ่อน (ผูกทีหลังได้ผ่าน cutover_transfer_invoice, 0158) — normalize ด้วย
  -- sanitize_inv_no() (SECTION 4B) ให้ตรงกับ sanitizeInvNo() ฝั่ง frontend เป๊ะ แล้วตรวจซ้ำกันสัญญาอื่นก่อนเลย
  v_new_inv_no_norm := public.sanitize_inv_no(p_new_inv_no);
  if v_new_inv_no_norm is not null
     and exists (select 1 from public.contracts where inv_no = v_new_inv_no_norm and id <> p_contract_id)
  then
    raise exception 'เลขที่ใบ INV นี้ถูกใช้กับสัญญาอื่นแล้ว: %', v_new_inv_no_norm;
  end if;

  -- ---------------------------------------------------------------------
  -- เอกสารแนบต้องครบตาม v_slot_spec ก่อนยืนยัน (นับเฉพาะไฟล์ที่ไม่ถูก soft-delete)
  -- ---------------------------------------------------------------------
  for v_slot in select * from jsonb_array_elements(v_slot_spec)
  loop
    select count(*) into v_slot_cnt
      from public.contract_media
     where contract_id = p_contract_id
       and deleted_at is null
       and slot_key = 'transfer_' || v_round || '_' || (v_slot ->> 'suffix');

    if coalesce(v_slot_cnt, 0) < coalesce((v_slot ->> 'min')::int, 1) then
      v_missing := array_append(v_missing, coalesce(v_slot ->> 'label', v_slot ->> 'suffix'));
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'ยังยืนยันไม่ได้ ขาด: %', array_to_string(v_missing, ', ');
  end if;

  -- ---------------------------------------------------------------------
  -- snapshot ที่อยู่เดิมทั้งหมด (ทุก kind ที่มีอยู่จริง) เก็บเป็น camelCase ตรงกับ CustomerAddress (src/lib/types.ts)
  -- ---------------------------------------------------------------------
  select coalesce(jsonb_object_agg(kind, jsonb_build_object(
           'houseNo', house_no, 'moo', moo, 'soi', soi, 'road', road,
           'subdistrict', subdistrict, 'district', district,
           'province', province, 'postalCode', postal_code
         )), '{}'::jsonb)
    into v_old_addresses
  from public.customer_addresses
  where contract_id = p_contract_id;

  -- ---------------------------------------------------------------------
  -- insert snapshot (created_by/created_by_name auto จาก trigger set_contract_transfer_recorder)
  -- ---------------------------------------------------------------------
  insert into public.contract_transfers (
    contract_id, transfer_no,
    old_customer_name, new_customer_name,
    old_national_id, new_national_id,
    old_phone, new_phone,
    old_phone_alt1, new_phone_alt1,
    old_phone_alt2, new_phone_alt2,
    old_birth_year, new_birth_year,
    old_occupation, new_occupation,
    old_occupation_proof, new_occupation_proof,
    old_facebook_link, new_facebook_link,
    old_dnc, new_dnc,
    old_dnc_reason, new_dnc_reason,
    old_promise_to_pay_date, new_promise_to_pay_date,
    old_addresses, new_addresses,
    old_inv_no, new_inv_no,
    note
  ) values (
    p_contract_id, v_round,
    v_c.customer_name, v_new_customer_name,
    v_c.national_id, v_new_national_id,
    v_c.phone, v_new_phone,
    v_c.phone_alt1, v_new_phone_alt1,
    v_c.phone_alt2, v_new_phone_alt2,
    v_c.birth_year, v_new_birth_year,
    v_c.occupation, v_new_occupation,
    v_c.occupation_proof, v_new_occupation_proof,
    v_c.facebook_link, v_new_facebook,
    v_c.dnc, false,
    v_c.dnc_reason, null,
    v_c.promise_to_pay_date, null,
    v_old_addresses, coalesce(p_addresses, '{}'::jsonb),
    v_c.inv_no, v_new_inv_no_norm,
    p_note
  ) returning id into v_transfer_id;

  -- ---------------------------------------------------------------------
  -- อัปเดตสัญญา — GUC bypass Guard B (SECTION 3) + trg_prevent_staff_unflag เฉพาะ dnc (SECTION 4)
  -- ห้าม UPDATE installments/payment_log/other_income/เงิน/คอม/summary_*/assigned_to/disputed/lawyer_* (บรีฟ)
  -- ---------------------------------------------------------------------
  perform set_config('app.transfer_rpc', '1', true);

  update public.contracts set
    customer_name        = v_new_customer_name,
    national_id          = v_new_national_id,
    phone                = v_new_phone,
    phone_alt1           = v_new_phone_alt1,
    phone_alt2           = v_new_phone_alt2,
    birth_year           = v_new_birth_year,
    occupation           = v_new_occupation,
    occupation_proof     = v_new_occupation_proof,
    facebook_link        = v_new_facebook,
    dnc                  = false,
    dnc_reason           = null,
    promise_to_pay_date  = null
  where id = p_contract_id;

  -- 🔒 hardening (ติ๊กรีวิว 2026-09-14): set_config(...,true) เป็น transaction-local ไม่ใช่ function-local —
  -- ถ้ามีใครยิงหลาย statement ใน transaction เดียวกัน (เช่น dry-run/สคริปต์มือ) ต้องรีบเคลียร์ GUC ทันทีที่
  -- UPDATE ซึ่งต้อง bypass เสร็จแล้ว กัน Guard B/trg_prevent_staff_unflag ค้างเปิดไปบล็อกถัดไปในทรานแซกชัน
  -- เดียวกันโดยไม่ตั้งใจ (prod จริงแต่ละ request = 1 ทรานแซกชันอยู่แล้วไม่เจอปัญหานี้ — กันไว้เผื่ออนาคต)
  perform set_config('app.transfer_rpc', '', true);

  -- upsert ที่อยู่ใหม่ทุกชนิดที่ส่งมา (current/id_card/work บังคับผ่าน validate ด้านบนแล้ว, registry ไม่บังคับ)
  for v_kind in select jsonb_object_keys(coalesce(p_addresses, '{}'::jsonb))
  loop
    if v_kind not in ('current', 'id_card', 'work', 'registry') then
      raise exception 'ชนิดที่อยู่ไม่ถูกต้อง: %', v_kind;
    end if;
    v_addr := p_addresses -> v_kind;
    insert into public.customer_addresses (
      contract_id, kind, house_no, moo, soi, road, subdistrict, district, province, postal_code, updated_at
    ) values (
      p_contract_id, v_kind,
      nullif(v_addr ->> 'houseNo', ''), nullif(v_addr ->> 'moo', ''), nullif(v_addr ->> 'soi', ''),
      nullif(v_addr ->> 'road', ''), nullif(v_addr ->> 'subdistrict', ''), nullif(v_addr ->> 'district', ''),
      nullif(v_addr ->> 'province', ''), nullif(v_addr ->> 'postalCode', ''), now()
    )
    on conflict (contract_id, kind) do update set
      house_no = excluded.house_no, moo = excluded.moo, soi = excluded.soi, road = excluded.road,
      subdistrict = excluded.subdistrict, district = excluded.district, province = excluded.province,
      postal_code = excluded.postal_code, updated_at = excluded.updated_at;
  end loop;

  return jsonb_build_object('transfer_id', v_transfer_id, 'transfer_no', v_round);
end;
$$;

grant execute on function public.transfer_contract_owner(uuid, jsonb, jsonb, text, text)
  to authenticated, service_role;

comment on function public.transfer_contract_owner(uuid, jsonb, jsonb, text, text) is
  '(0157) admin/staff (active) เปลี่ยนผู้ผ่อนบนสัญญาเดิม (status=active เท่านั้น) — validate required fields (บาร์เดียวกับ AddContract) + national_id 13 หลัก + ที่อยู่ current/id_card/work บังคับ + เอกสารแนบครบตาม v_slot_spec (id_card_front>=1, occupation_photo>=1, contract_docs>=4, id_copy_consent>=1, credit_check>=1 — namespaced transfer_{N}_*, เพิ่มโดยคุณเตย 2026-09-14 ไม่มีขั้นแอดมินตรวจเอกสารแยก/ไม่แตะ review_status); snapshot คนเดิม+ที่อยู่เดิมลง contract_transfers, รีเซ็ต dnc/dnc_reason/promise_to_pay_date; ไม่แตะ inv_no ตรง (เก็บไว้ใน transfers.new_inv_no รอ cutover_transfer_invoice, 0158) ห้ามแตะเงิน/installments/summary/assigned_to/disputed/lawyer_*';


-- ============================================================================
-- SECTION 6: RPC undo_contract_transfer — admin ยกเลิกรายการล่าสุด (เวอร์ชันฐาน — ยังไม่รู้จัก cutover)
-- ⚠️ 0158 จะ create or replace ฟังก์ชันนี้ใหม่ทั้งตัว ให้รู้จัก pj_receipt_ignores + คืนเลข INV เดิม
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

  if v_t.cutover_at is not null then
    -- (0157) เวอร์ชันนี้ยังไม่รู้จัก pj_receipt_ignores/การคืนเลข INV — 0158 จะ create or replace ฟังก์ชันนี้
    -- ใหม่ให้รองรับเคส cutover แล้ว ถ้าเห็น error นี้แปลว่า apply 0158 ไม่สำเร็จ/ไม่ครบ
    raise exception 'สัญญานี้ผูกเลขที่ใบ PJ ใหม่ไปแล้ว (cutover) — ต้องยกเลิกผ่านระบบที่รู้จัก PJ (migration 0158) กรุณาติดต่อผู้ดูแลระบบ';
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
    promise_to_pay_date  = v_t.old_promise_to_pay_date
  where id = v_t.contract_id;

  -- 🔒 hardening (ติ๊กรีวิว 2026-09-14) — เคลียร์ GUC ทันทีหลัง UPDATE ที่ต้อง bypass เสร็จ (เหตุผลเดียวกับ
  -- transfer_contract_owner ด้านบน — set_config(...,true) เป็น transaction-local ไม่ใช่ function-local)
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

  update public.contract_transfers set
    reversed_at      = now(),
    reversed_by      = auth.uid(),
    reversed_by_name = v_by_name,
    reversed_reason  = btrim(p_reason)
  where id = p_transfer_id;
end;
$$;

grant execute on function public.undo_contract_transfer(uuid, text) to authenticated, service_role;

comment on function public.undo_contract_transfer(uuid, text) is
  '(0157, เวอร์ชันฐาน — ยังไม่รองรับ cutover, 0158 จะ create or replace ทับ) admin เท่านั้น ยกเลิกรายการเปลี่ยนผู้ผ่อนล่าสุดของสัญญา (ต้องยังไม่ผูกเลข INV ใหม่); reason บังคับ; refuse ถ้าค่าปัจจุบันบนสัญญา/ที่อยู่ไม่ตรงกับ new_* ที่บันทึกไว้ (มีคนแก้ทับ); คืน old_* ทั้งหมด รวมที่อยู่';


-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) ตาราง + คอลัมน์ใหม่ครบ:
-- select table_name from information_schema.tables where table_schema='public' and table_name='contract_transfers';
-- select column_name from information_schema.columns where table_schema='public' and table_name='fee_waivers' and column_name='transfer_id';

-- b) authenticated มีสิทธิ์ select บนตารางใหม่ + execute บน RPC:
-- select has_table_privilege('authenticated', 'public.contract_transfers', 'SELECT'); -- true
-- select has_table_privilege('authenticated', 'public.contract_transfers', 'INSERT'); -- false (เขียนผ่าน RPC เท่านั้น)
-- select has_function_privilege('authenticated', 'public.transfer_contract_owner(uuid,jsonb,jsonb,text,text)', 'EXECUTE'); -- true
-- select has_function_privilege('authenticated', 'public.undo_contract_transfer(uuid,text)', 'EXECUTE'); -- true

-- c) service_role มีสิทธิ์ครบ:
-- select has_table_privilege('service_role', 'public.contract_transfers', 'SELECT'); -- true

-- d) trigger ยังมีตัวเดียวบน contracts ต่อชื่อ (ไม่ได้เพิ่ม trigger ที่สอง):
-- select tgname, count(*) from pg_trigger where tgrelid='public.contracts'::regclass
--   and tgname in ('contracts_review_guard','trg_prevent_staff_unflag') group by tgname;
-- expected: 1 แถวต่อชื่อ

-- e) fee_waivers constraint + partial unique index ครบ:
-- select conname from pg_constraint where conrelid='public.fee_waivers'::regclass order by conname;
-- select indexname from pg_indexes where tablename='fee_waivers' order by indexname;

-- f) contracts_generated_columns() ไม่ถูกแตะ (Guard B ยัง deny-list ปกติ):
-- select public.contracts_generated_columns(); -- expected: {after_down,commission_amount,net_transfer}

-- g) sanitize_inv_no() ทำงานตรงกับ sanitizeInvNo() ฝั่ง frontend (ติ๊กรีวิว YELLOW #4):
-- select public.sanitize_inv_no('  inv-17852281569780 Finish  '); -- expected: INV-17852281569780
-- select public.sanitize_inv_no(null); -- expected: null
-- select public.sanitize_inv_no('   '); -- expected: null
