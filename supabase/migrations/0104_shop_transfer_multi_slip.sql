-- 0104: รองรับ "หลายสลิปต่อร้านต่อวัน + ผูกสลิปกับสัญญาที่จ่ายให้" บนหน้าโอนเงินร้าน (/transfers)
-- ต่อยอดจาก 0083 (shop_transfer 1แถว/ร้าน/วัน) + 0085 (slip_waived) — additive 100% ไม่แตะ/ลบของเดิม
--
-- Pete เคาะ (2026-07-13):
--   1) บัญชีติ๊กเลือกสัญญาที่สลิปใบนั้นจ่ายให้ → ยอดสลิป default = Σ net ของเคสที่เลือก (แก้เองได้)
--   2) 1 สัญญา = อยู่ได้ 1 สลิป (v1 ไม่รองรับจ่ายบางส่วนข้ามหลายสลิป) — กันผูกสัญญาซ้ำ 2 สลิปในร้าน-วันเดียว
--   3) "โอนครบ" ของร้าน-วัน = ทุกสัญญาที่ต้องโอนถูกผูกกับสลิปครบ (คำนวณฝั่งแอป ไม่เก็บสถานะนี้ใน DB)
--   4) ไม่ตั้ง "โหมด" ต่อร้าน — ลงกี่สลิปก็ได้ (เคสต่อเคส=หลายสลิปสลิปละ1เคส / โอนรวม=1สลิปหลายเคส เกิดเอง)
--
-- โครงสร้าง: shop_transfer 1 แถว = 1 สลิป (เลิก unique ร้าน-วัน) + shop_transfer_item = สัญญาที่สลิปนั้นจ่ายให้
--   ลบสลิปผิด = soft void (voided=true) ไม่ hard delete — กันหลักฐานหาย (ยึด pattern 0083 "ไม่มี DELETE policy")

-- ============================================================================
-- SECTION 1: ปลดล็อก unique (shop_id, transfer_date) — ให้มีหลายแถว/ร้าน/วันได้
-- constraint นี้ 0083 สร้างแบบไม่ตั้งชื่อเอง → Postgres ตั้งชื่ออัตโนมัติ shop_transfer_shop_id_transfer_date_key
-- ============================================================================

alter table public.shop_transfer drop constraint if exists shop_transfer_shop_id_transfer_date_key;

-- ============================================================================
-- SECTION 2: soft-void บน shop_transfer (แต่ละแถว = 1 สลิป)
-- voided=true = สลิปถูกยกเลิก (ไม่นับยอด/ไม่นับ "โอนครบ") — เก็บแถวไว้เป็นประวัติ
-- ============================================================================

alter table public.shop_transfer add column if not exists voided boolean not null default false;

comment on column public.shop_transfer.voided is
  '0104: true = สลิปนี้ถูกยกเลิก (soft delete โดย admin) — ไม่นับยอด/ไม่นับโอนครบ แต่คงแถวไว้เป็นประวัติ';

-- ============================================================================
-- SECTION 3: ตาราง shop_transfer_item — สัญญาที่สลิป (shop_transfer แถวนั้น) จ่ายให้
-- 1 สลิป (transfer_id) → N สัญญา (contract_id). amount = ยอดที่บันทึกว่าจ่ายให้เคสนั้น (snapshot)
-- ============================================================================

create table if not exists public.shop_transfer_item (
  id           uuid primary key default gen_random_uuid(),
  transfer_id  uuid not null references public.shop_transfer (id) on delete cascade,
  contract_id  uuid not null references public.contracts (id) on delete restrict,
  amount       numeric not null,
  created_at   timestamptz not null default now()
);

create index if not exists shop_transfer_item_transfer_idx on public.shop_transfer_item (transfer_id);
create index if not exists shop_transfer_item_contract_idx on public.shop_transfer_item (contract_id);

comment on table public.shop_transfer_item is
  '0104: สัญญาที่สลิปหนึ่ง (shop_transfer.id) จ่ายให้ — 1 สลิป N สัญญา. amount=ยอดต่อเคส (snapshot ตอนบันทึก)';

-- หมายเหตุ (partial unique กันสัญญาซ้ำหลายสลิป):
--   เงื่อนไข "กัน 1 สัญญาซ้ำในหลายสลิปที่ voided=false ของร้าน-วันเดียว" อ้าง shop_id/transfer_date/voided
--   ซึ่งอยู่บนตารางแม่ (shop_transfer) คนละตารางกับ contract_id (อยู่ shop_transfer_item)
--   → unique index บนตารางลูกเพียงตัวเดียวอ้างคอลัมน์ตารางแม่ไม่ได้ (ต้อง cross-table)
--   จึง "บังคับใน RPC create_transfer_slip" (ตรวจก่อน insert แต่ละเคส แล้ว raise ถ้าซ้ำ) แทน
--   ไม่ใส่ unique(contract_id) เดี่ยว ๆ เพราะสัญญาปิดแล้วคืน/แก้ย้อนหลังอาจต้องผูกสลิปคนละวัน (global unique จะบล็อกเกินจำเป็น)

-- ============================================================================
-- SECTION 4: RLS shop_transfer_item — เลียนแบบ shop_transfer (0083) เป๊ะ
-- read/insert/update = admin + accounting. ไม่มี DELETE policy (ลบผ่าน service_role/cascade เท่านั้น)
-- ============================================================================

alter table public.shop_transfer_item enable row level security;

drop policy if exists shop_transfer_item_read on public.shop_transfer_item;
create policy shop_transfer_item_read on public.shop_transfer_item
  for select to authenticated
  using (is_admin() OR is_accounting());

drop policy if exists shop_transfer_item_insert on public.shop_transfer_item;
create policy shop_transfer_item_insert on public.shop_transfer_item
  for insert to authenticated
  with check (is_admin() OR is_accounting());

drop policy if exists shop_transfer_item_update on public.shop_transfer_item;
create policy shop_transfer_item_update on public.shop_transfer_item
  for update to authenticated
  using (is_admin() OR is_accounting())
  with check (is_admin() OR is_accounting());

-- ============================================================================
-- SECTION 5: GRANT (ตาม 0017 pattern — 0017 ALTER DEFAULT PRIVILEGES ครอบ public.* อยู่แล้ว เพิ่ม explicit เพื่อชัด/audit)
-- shop_transfer_item ใช้ gen_random_uuid() เป็น default (ไม่ใช่ sequence) → ไม่ต้อง grant usage บน sequence
-- ============================================================================

grant select, insert, update on public.shop_transfer_item to authenticated;
grant all on public.shop_transfer_item to service_role;

-- ============================================================================
-- SECTION 6: view v_transfer_slip_summary — สรุปจำนวนสลิป + ยอดรวม ต่อ (ร้าน, วัน) นับเฉพาะ voided=false
-- ============================================================================

create or replace view public.v_transfer_slip_summary as
select
  t.transfer_date,
  t.shop_id,
  count(*)::int                                        as slip_count,
  coalesce(sum(t.amount), 0)                           as total_amount,
  count(*) filter (where exists (
    select 1 from public.shop_transfer_item i where i.transfer_id = t.id
  ))::int                                              as slip_with_items
from public.shop_transfer t
where t.voided = false
group by t.transfer_date, t.shop_id;

grant select on public.v_transfer_slip_summary to authenticated, service_role;

comment on view public.v_transfer_slip_summary is
  '0104: สรุปสลิปโอนต่อ (ร้าน,วัน) เฉพาะ voided=false — slip_count=จำนวนสลิป, total_amount=Σยอดสลิป, slip_with_items=สลิปที่มีสัญญาผูก';

-- ============================================================================
-- SECTION 7: RPC atomic (SECURITY DEFINER + guard สิทธิ์ต้นฟังก์ชัน)
-- ============================================================================

-- 7a) create_transfer_slip — สร้าง 1 สลิป + ผูกสัญญาที่จ่ายให้ (atomic)
--   p_items = jsonb array [{ "contract_id": "...", "amount": 123 }, ...]
--   ตรวจก่อนผูกแต่ละเคส: สัญญานั้นต้องยังไม่ถูกผูกกับสลิป voided=false อื่นของร้าน-วันเดียว (กันซ้ำ ตาม Pete ข้อ 2)
--   (ตรวจ "หลัง insert แม่ก่อน insert item" → ครอบทั้งสลิปอื่น + สัญญาซ้ำภายใน p_items เอง เพราะ item ถูก insert ทีละตัว)
--   คืน transfer_id ของสลิปที่สร้าง

drop function if exists public.create_transfer_slip(uuid, date, numeric, text, text, boolean, jsonb);
create or replace function public.create_transfer_slip(
  p_shop_id       uuid,
  p_transfer_date date,
  p_amount        numeric,
  p_slip_path     text,
  p_note          text,
  p_slip_waived   boolean,
  p_items         jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_transfer_id uuid;
  v_by          text;
  v_elem        jsonb;
  v_contract_id uuid;
  v_item_amount numeric;
begin
  -- guard: เฉพาะ admin / accounting
  if not (is_admin() or is_accounting()) then
    raise exception 'ไม่มีสิทธิ์: create_transfer_slip ต้องเป็น admin หรือ accounting เท่านั้น';
  end if;

  -- ชื่อคนบันทึก (snapshot จาก profiles ของ auth.uid())
  select full_name into v_by from public.profiles where id = auth.uid();

  -- สร้างแถวสลิป (1 แถว = 1 สลิป)
  insert into public.shop_transfer
    (shop_id, transfer_date, amount, transferred, slip_path, transferred_by, transferred_at, note, slip_waived, voided)
  values
    (p_shop_id, p_transfer_date, coalesce(p_amount, 0), true, p_slip_path, v_by, now(), p_note, coalesce(p_slip_waived, false), false)
  returning id into v_transfer_id;

  -- ผูกสัญญาที่สลิปนี้จ่ายให้
  if p_items is not null then
    for v_elem in select * from jsonb_array_elements(p_items)
    loop
      v_contract_id := (v_elem->>'contract_id')::uuid;
      v_item_amount := coalesce((v_elem->>'amount')::numeric, 0);

      -- กันสัญญาซ้ำ: มีสัญญานี้ผูกกับสลิป voided=false ใด ๆ ของร้าน-วันนี้อยู่แล้วหรือยัง
      -- (รวมสลิปที่เพิ่ง insert ในลูปนี้ด้วย → กัน contract_id ซ้ำภายใน p_items เอง)
      if exists (
        select 1
        from public.shop_transfer_item i
        join public.shop_transfer t on t.id = i.transfer_id
        where t.shop_id = p_shop_id
          and t.transfer_date = p_transfer_date
          and t.voided = false
          and i.contract_id = v_contract_id
      ) then
        raise exception 'สัญญานี้ถูกผูกกับสลิปอื่นในร้าน-วันเดียวกันแล้ว (1 สัญญาอยู่ได้สลิปเดียว) contract_id=%', v_contract_id;
      end if;

      insert into public.shop_transfer_item (transfer_id, contract_id, amount)
      values (v_transfer_id, v_contract_id, v_item_amount);
    end loop;
  end if;

  return v_transfer_id;
end;
$$;

grant execute on function public.create_transfer_slip(uuid, date, numeric, text, text, boolean, jsonb)
  to authenticated, service_role;

-- 7b) void_transfer_slip — ยกเลิกสลิป (soft delete) เฉพาะ admin
drop function if exists public.void_transfer_slip(uuid);
create or replace function public.void_transfer_slip(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if not is_admin() then
    raise exception 'ไม่มีสิทธิ์: void_transfer_slip ต้องเป็น admin เท่านั้น';
  end if;

  update public.shop_transfer
     set voided = true
   where id = p_transfer_id;

  if not found then
    raise exception 'ไม่พบสลิปที่จะยกเลิก: %', p_transfer_id;
  end if;
end;
$$;

grant execute on function public.void_transfer_slip(uuid) to authenticated, service_role;

-- ============================================================================
-- SECTION 8: Smoke SQL (รันมือหลัง apply ผ่าน MCP)
-- ============================================================================
-- 1) unique เดิมถูกปลด:
--    select conname from pg_constraint c join pg_class r on r.oid=c.conrelid
--     where r.relname='shop_transfer' and c.contype='u';
--    expected: ไม่มี shop_transfer_shop_id_transfer_date_key
-- 2) ตาราง+grant ใหม่:
--    select has_table_privilege('service_role','public.shop_transfer_item','INSERT');  -- expected true
--    select has_table_privilege('authenticated','public.shop_transfer_item','SELECT'); -- expected true
-- 3) view:
--    select * from public.v_transfer_slip_summary limit 1;
-- 4) RPC สร้างสำเร็จ:
--    select routine_name from information_schema.routines
--     where routine_schema='public' and routine_name in ('create_transfer_slip','void_transfer_slip');
--    expected: 2 rows
