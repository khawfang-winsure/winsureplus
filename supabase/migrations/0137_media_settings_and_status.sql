-- 0137: ตั้งค่าระบบรูปเอกสารแนบ (media_slots ฯลฯ) + ตารางสรุปสถานะต่อสัญญา + RPC ที่เกี่ยวข้อง
-- เป้าหมาย: เก็บ config 14 ช่องแนบรูป (admin แก้ได้ผ่าน app_settings ตรงๆ ไปก่อน — ยังไม่มีหน้า UI แก้)
-- + view รวมนับไฟล์ต่อสัญญา (ให้ /contracts, ContractDetail โชว์ป้ายสถานะได้ไว)
-- + RPC หาไฟล์ซ้ำข้ามสัญญา (SECURITY DEFINER — ผู้ใช้ทั่วไปไม่ควรเห็นสัญญาอื่นตรงๆ)
-- + RPC เช็คพื้นที่เก็บ storage (guard 800MB ฟรีของ Supabase)
-- + ตาราง+RPC log การข้ามการตรวจของแอดมิน (contract_media_gate_override) — ใส่รวมไว้ที่นี่เพื่อให้
--   ไฟล์นี้ self-contained (RPC log_media_gate_bypass ต้องมีตารางเป้าหมายอยู่ในไฟล์เดียวกัน)
-- Additive ทั้งหมด — app_settings ใช้ on conflict do nothing (ไม่ทับค่าที่ admin แก้เองไปแล้ว)

-- ============================================================================
-- SECTION 1: seed app_settings (ตาม pattern เดิม: key/value เป็น text, JSON เก็บเป็น string)
-- ============================================================================

insert into app_settings (key, value, description) values
  ('media_slots', $json$[
  { "key": "id_card_front",       "label": "หน้าบัตรประชาชนลูกค้า",              "sortOrder": 1,  "min": 1, "max": 1,         "required": "always" },
  { "key": "occupation_photo",    "label": "รูปอาชีพ",                          "sortOrder": 2,  "min": 1, "max": null,      "required": "always", "hint": "ใส่ได้หลายรูป" },
  { "key": "device_around",       "label": "รูปรอบตัวเครื่อง",                   "sortOrder": 3,  "min": 5, "max": null,      "required": "always", "hint": "ถ่าย บน ล่าง ซ้าย ขวา หน้า หลัง อย่างน้อย 5 มุม" },
  { "key": "box_back",            "label": "รูปหลังกล่อง",                       "sortOrder": 4,  "min": 1, "max": 1,         "required": { "when": "condition", "equals": "new" } },
  { "key": "settings_about",      "label": "หน้าตั้งค่า > เกี่ยวกับ",             "sortOrder": 5,  "min": 1, "max": 1,         "required": "always" },
  { "key": "imei_photo",          "label": "รูปเลข IMEI",                       "sortOrder": 6,  "min": 0, "max": 1,         "required": "never" },
  { "key": "battery_health",      "label": "รูปสุขภาพแบตเตอรี่",                 "sortOrder": 7,  "min": 1, "max": 1,         "required": "always" },
  { "key": "garuda_emblem",       "label": "รูปตราครุฑ",                        "sortOrder": 8,  "min": 1, "max": 1,         "required": "always" },
  { "key": "contract_docs",       "label": "เอกสารสัญญามีลายเซ็น",               "sortOrder": 9,  "min": 4, "max": null,      "required": "always", "hint": "ต้องมีอย่างน้อย 4 แผ่น" },
  { "key": "id_copy_consent",     "label": "สำเนาบัตรฯ เซ็นยินยอม",              "sortOrder": 10, "min": 1, "max": 1,         "required": "always" },
  { "key": "receipt",             "label": "ใบเสร็จ",                           "sortOrder": 11, "min": 1, "max": 1,         "required": "always" },
  { "key": "customer_id_imei",    "label": "ลูกค้าถือบัตร + เครื่องโชว์ IMEI",   "sortOrder": 12, "min": 1, "max": 1,         "required": "always", "hint": "ให้ลูกค้ากด *#06# แล้วถือบัตรคู่เครื่อง" },
  { "key": "credit_check",        "label": "ผลเช็คเครดิต",                       "sortOrder": 13, "min": 1, "max": 1,         "required": "always" },
  { "key": "credit_history_evidence", "label": "ใบแจ้งความ / หลักฐานเคลียร์ยอด", "sortOrder": 13.1, "min": 1, "max": null,   "required": { "when": "flag", "name": "credit_history_found" } },
  { "key": "device_on_off",       "label": "สถานะ On/Off ของเครื่อง",           "sortOrder": 14, "min": 1, "max": 1,         "required": "always" }
]$json$, 'ช่องแนบรูปเอกสาร 14 ช่อง (JSON array) — แก้ตรงในตารางนี้ ยังไม่มีหน้า UI แก้ (2026-09-08)'),
  ('media_provider', 'supabase', 'ที่เก็บไฟล์รูปเอกสาร: supabase | r2 (ย้ายไป R2 ทีหลังตาม wave 6)'),
  ('media_gate_from', '2026-09-09', 'สัญญาที่สร้างตั้งแต่วันนี้เป็นต้นไป ต้องแนบรูปครบก่อนส่งอีเมล (สัญญาเก่ากว่านี้ไม่ถูกบังคับ)'),
  ('media_storage_guard_mb', '800', 'เพดานพื้นที่เก็บรูป (MB) กันเต็มฟรีโควต้า Supabase Storage'),
  ('company_email_to', '', 'อีเมลปลายทางที่ส่งเอกสารสัญญาให้บริษัท (ว่าง = ยังตั้งไม่เสร็จ ส่งไม่ได้)'),
  ('media_email_note_video', 'true', 'true = ต่อท้ายอีเมลด้วยข้อความแจ้งว่าวิดีโอส่งแยกทาง Gmail')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 2: ตาราง contract_media_gate_override — log การข้ามการตรวจไฟล์ครบของแอดมิน
-- ============================================================================

create table if not exists public.contract_media_gate_override (
  id            uuid primary key default gen_random_uuid(),
  contract_id   uuid not null references public.contracts (id) on delete cascade,
  reason        text not null,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists contract_media_gate_override_contract_idx
  on public.contract_media_gate_override (contract_id);

comment on table public.contract_media_gate_override is
  'ประวัติที่แอดมินกด "ข้ามการตรวจ (แอดมินเท่านั้น)" เมื่อรูปเอกสารยังไม่ครบ แต่ต้องส่งอีเมลไปก่อน — เขียนผ่าน RPC log_media_gate_bypass เท่านั้น';

alter table public.contract_media_gate_override enable row level security;

drop policy if exists contract_media_gate_override_select on public.contract_media_gate_override;
create policy contract_media_gate_override_select
  on public.contract_media_gate_override
  for select to authenticated
  using (is_admin() or is_staff() or is_accounting());

-- ไม่มี INSERT/UPDATE/DELETE policy สำหรับ authenticated ตรงๆ — เขียนได้ทางเดียวผ่าน RPC
-- log_media_gate_bypass (SECURITY DEFINER เช็ค is_admin() เองในฟังก์ชัน) หรือ service_role เท่านั้น

grant select on public.contract_media_gate_override to authenticated;
grant select, insert, update, delete on public.contract_media_gate_override to service_role;

-- ============================================================================
-- SECTION 3: view v_contract_media_status — 1 แถวต่อสัญญา (LEFT JOIN สัญญาที่ยังไม่มีไฟล์ก็ต้องขึ้น)
-- security_invoker = on ให้เกาะ RLS ของ contracts/contract_media ตาม role ที่ query จริง (เหมือน 0055/0090)
-- ============================================================================

create or replace view public.v_contract_media_status
  with (security_invoker = on) as
select
  c.id                                    as contract_id,
  coalesce(cm.counts, '{}'::jsonb)        as counts,
  coalesce(cm.total_files, 0)             as total_files,
  c.condition,
  c.origin,
  c.credit_history_found,
  c.created_at
from public.contracts c
left join (
  select
    s.contract_id,
    jsonb_object_agg(s.slot_key, s.cnt) as counts,
    sum(s.cnt)                          as total_files
  from (
    select contract_id, slot_key, count(distinct sha256) as cnt
    from public.contract_media
    where deleted_at is null
    group by contract_id, slot_key
  ) s
  group by s.contract_id
) cm on cm.contract_id = c.id;

comment on view public.v_contract_media_status is
  'สรุปจำนวนไฟล์แนบต่อสัญญา (นับ distinct sha256 ต่อช่อง กันนับไฟล์ซ้ำ) — LEFT JOIN สัญญาที่ยังไม่มีไฟล์เลยก็ยังขึ้นแถว (counts={}, total_files=0)';

grant select on public.v_contract_media_status to authenticated, service_role;

-- ============================================================================
-- SECTION 4: RPC find_media_duplicate — หาไฟล์ที่เคยอัปที่อื่นด้วย sha256 เดียวกัน (ข้ามสัญญา)
-- SECURITY DEFINER เพราะ caller (staff ปกติ) ไม่ควรเห็นสัญญาอื่นตรงๆ ผ่าน RLS ปกติ — ฟังก์ชันนี้คืนแค่
-- contract_no + ชื่อลูกค้าแบบ mask (2 ตัวแรก + ***) พอให้เทียบว่าใช่ไฟล์เก่าคีย์ผิดสัญญาหรือเปล่า
-- ============================================================================

create or replace function public.find_media_duplicate(
  p_sha256 text,
  p_exclude_contract_id uuid default null
)
returns table (
  contract_id uuid,
  contract_no text,
  customer_name_masked text,
  slot_key text,
  uploaded_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    cm.contract_id,
    c.contract_no,
    (left(c.customer_name, 2) || '***') as customer_name_masked,
    cm.slot_key,
    cm.uploaded_at
  from public.contract_media cm
  join public.contracts c on c.id = cm.contract_id
  where cm.sha256 = p_sha256
    and cm.deleted_at is null
    and (p_exclude_contract_id is null or cm.contract_id <> p_exclude_contract_id)
  order by cm.uploaded_at asc
  limit 1
$$;

grant execute on function public.find_media_duplicate(text, uuid) to authenticated, service_role;

-- ============================================================================
-- SECTION 5: RPC media_storage_usage_bytes — รวมขนาดไฟล์ทั้งหมดใน bucket contract-media
-- SECURITY DEFINER เพราะ authenticated ปกติไม่มีสิทธิ์ query storage.objects ตรงๆ ข้าม row ของตัวเอง
-- ============================================================================

create or replace function public.media_storage_usage_bytes()
returns bigint
language sql
stable
security definer
set search_path = public, storage
as $$
  select coalesce(sum((metadata ->> 'size')::bigint), 0)
  from storage.objects
  where bucket_id = 'contract-media'
$$;

grant execute on function public.media_storage_usage_bytes() to authenticated, service_role;

-- ============================================================================
-- SECTION 6: RPC log_media_gate_bypass — บันทึกเหตุผลตอนแอดมินกด "ข้ามการตรวจ"
-- SECURITY DEFINER + เช็ค is_admin() เองในฟังก์ชัน (กัน authenticated ทั่วไปเรียกตรงแล้วเลี่ยง RLS)
-- ============================================================================

create or replace function public.log_media_gate_bypass(
  p_contract_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ข้ามการตรวจได้';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'ต้องระบุเหตุผลที่ข้าม';
  end if;
  insert into public.contract_media_gate_override (contract_id, reason, created_by)
  values (p_contract_id, trim(p_reason), auth.uid());
end;
$$;

grant execute on function public.log_media_gate_bypass(uuid, text) to authenticated, service_role;

-- ============================================================================
-- SECTION 7: Smoke SQL (รันมือหลัง apply เพื่อ verify — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================
-- 1) seed ครบ 6 key:
-- SELECT key, length(value) FROM app_settings
--   WHERE key IN ('media_slots','media_provider','media_gate_from','media_storage_guard_mb','company_email_to','media_email_note_video');
--
-- 2) media_slots parse เป็น JSON ได้ + มี 15 ช่อง (รวม 13.1):
-- SELECT jsonb_array_length(value::jsonb) FROM app_settings WHERE key = 'media_slots'; -- expected 15
--
-- 3) view คืนแถวครบเท่าจำนวนสัญญา (contract ใหม่ที่ยังไม่มีไฟล์ต้องขึ้น total_files=0):
-- SELECT count(*) FROM v_contract_media_status;
-- SELECT count(*) FROM contracts;  -- ควรเท่ากัน
--
-- 4) service_role เข้าถึง view/ตารางใหม่ได้:
-- SELECT has_table_privilege('service_role', 'public.contract_media_gate_override', 'INSERT');
