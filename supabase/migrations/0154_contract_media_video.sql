-- 0154: Wave 1 ฟีเจอร์ "แนบคลิปเทสล็อกในเมลบริษัท" — เตรียม schema รับคลิป 1 คลิป/เคส + purge log
-- ────────────────────────────────────────────────────────────────────────────
-- เป้าหมาย (schema เท่านั้น — ไม่เขียน purge job จริง/ไม่แก้ Edge Function/ไม่แตะ src รอบนี้ แบมแก้
-- src/lib/media.ts ขนานอยู่):
--   1) contract_media เพิ่ม emailed_at/purged_at — นับอายุ 30 วันก่อนลบไฟล์จริงจาก storage โดยไม่ลบแถว/
--      metadata (ต่างจาก deleted_at ที่เป็น soft-delete ของฟีเจอร์ลบรูปผิด 0146)
--   2) unique index กันไฟล์ซ้ำ (0140) ต้องยอมให้ sha256 เดิมอัปใหม่ได้ ถ้าแถวเก่าถูก purge ไปแล้ว
--   3) เพิ่มช่องแนบ lock_test_video เข้า app_settings.media_slots (pattern append ตาม 0144)
--   4) seed ค่าตั้งต้นของฟีเจอร์คลิป — ปิดไว้ก่อนทั้งหมด (media_video_required_from = 2099-12-31)
--   5) media_gate_complete (0142) รองรับ flag ใหม่ "video_required" ควบคู่ flag เดิม credit_history_found
--   6) email_send_log รองรับสถานะ 'sending' ระหว่างส่งจริง + ผูก attached_media_ids ต่ออีเมลแต่ละฉบับ
--   7) ตารางใหม่ media_purge_log เก็บประวัติ purge (เขียนได้ทาง service_role เท่านั้น, admin อ่านได้)
--
-- คำตัดสินเจ้าของ (ล็อก 2026-09-13): คลิป 1 คลิป/เคส, เมลบริษัทฉบับเดียวแนบรูป+คลิป, ลบคลิปในเว็บ 30 วัน
-- หลังระบบส่งเมล ทุกเคสไม่ยกเว้น (เคสโต้แย้ง/ทนาย/คืนเครื่อง), รูปไม่ลบเลย — งานนี้เป็น Wave 1 (schema)
--
-- กฎ video_required (ต้องตรง TS ของแบมเป๊ะ):
--   video_required = media_video_required_from เป็นวันที่ถูกต้อง
--                    AND (contracts.created_at at time zone 'utc')::date >= media_video_required_from::date
--                    AND contracts.email_sent_at IS NULL
--   setting ว่าง/ผิดรูปแบบ → ไม่บังคับ (ห้าม raise, ห้ามทำให้ gate รูปเดิมหลวม/แน่นขึ้น) — ใช้
--   contracts.email_sent_at (ไม่ใช่ contract_media.emailed_at) เพราะพนักงานกด "ส่งเองแล้ว" ได้โดยคลิป
--   ไม่เคยออกจากเว็บจริง (ดู 0149 comment เรื่องเดียวกัน) — นับอายุ 30 วันของไฟล์ (purge) ใช้
--   contract_media.emailed_at (ประทับหลัง SMTP สำเร็จจริง) ต่างจากตัวนี้ที่ใช้เช็คว่า "ต้องแนบก่อนส่งไหม"
--
-- อ้างอิงที่อ่านมาแล้วก่อนเขียนไฟล์นี้: 0136 (contract_media+bucket), 0137 (settings+view+RPC),
-- 0138 (email_send_log), 0140 (unique index เดิม), 0142 (media_gate_complete+review state machine),
-- 0144 (pattern append slot แบบ idempotent), 0146 (media_soft_delete), 0149/0151/0153
-- (contracts_review_guard — ไฟล์นี้ไม่แตะ/ไม่ก็อปมาแก้เลยแม้บรรทัดเดียว)
--
-- Additive + idempotent ทุกคำสั่ง — ไม่แตะ/ลบตาราง คอลัมน์ หรือข้อมูลเดิม และไม่แตะ public.contracts เลย
-- (ถ้าจะเพิ่มคอลัมน์ contracts ในอนาคตต้องไปแก้ deny-list ของ Guard B ใน 0153 ด้วย — ไม่ใช่ scope รอบนี้)

-- ============================================================================
-- SECTION 1: contract_media เพิ่ม emailed_at (ประทับตอนอีเมลส่งสำเร็จจริง) + purged_at (ประทับตอนไฟล์
-- ถูกลบจริงจาก storage โดย purge job) — ทั้งคู่ nullable, ไม่มี default
-- ============================================================================

alter table public.contract_media
  add column if not exists emailed_at timestamptz,
  add column if not exists purged_at  timestamptz;

comment on column public.contract_media.emailed_at is
  '(0154) เวลาที่ระบบส่งอีเมลบริษัทสำเร็จ (SMTP OK) และไฟล์แถวนี้ถูกแนบไปด้วยจริง — จุดเริ่มนับอายุ 30 วัน (media_video_retention_days) ก่อน purge job ลบไฟล์จริงออกจาก storage. ใช้ตัวนี้ไม่ใช่ contracts.email_sent_at เพราะพนักงานกด "บันทึกว่าส่งเองแล้ว" ได้โดยไฟล์ไม่เคยออกจากเว็บจริง (ดู 0149) — รูปไม่ตั้งค่านี้ (ไม่ purge)';

comment on column public.contract_media.purged_at is
  '(0154) เวลาที่ purge job ลบไฟล์จริงออกจาก storage แล้ว (แถว/metadata ยังอยู่เป็นหลักฐาน ไม่ลบแถว) — deleted_at ยังเป็น null ตามเดิม (ไม่ใช่ soft-delete ของ 0146) เพื่อให้ media_gate_complete (0142/SECTION 5 ล่างนี้) และ v_contract_media_status (0137) ยังนับว่าช่องนี้ครบต่อไปหลัง purge';

-- ============================================================================
-- SECTION 2: สลับ unique index กันไฟล์ซ้ำ (0140) ให้ยอมรับ sha256 เดิมซ้ำได้หลังแถวเก่าถูก purge
-- สร้างใหม่ก่อน (เผื่อ purged_at) แล้วค่อย drop เดิม กันช่วงเวลาที่ไม่มี index คุ้มครองเลย —
-- idempotent: ถ้า index ปัจจุบันมี purged_at ในนิยามแล้ว (รันซ้ำ/apply ซ้ำ) ข้ามทั้งบล็อก
-- ============================================================================

do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'contract_media'
      and indexname = 'contract_media_unique_live'
      and indexdef ilike '%purged_at%'
  ) then
    raise notice 'contract_media_unique_live มี purged_at อยู่แล้ว — ข้าม (idempotent)';
    return;
  end if;

  execute 'create unique index if not exists contract_media_unique_live_v2
    on public.contract_media (contract_id, slot_key, sha256)
    where deleted_at is null and purged_at is null';

  execute 'drop index if exists public.contract_media_unique_live';

  execute 'alter index public.contract_media_unique_live_v2 rename to contract_media_unique_live';
end $$;

-- ============================================================================
-- SECTION 3: append ช่องแนบ lock_test_video เข้า app_settings.media_slots (pattern จาก 0144 เป๊ะ)
-- required เป็น flag ใหม่ "video_required" (คำนวณจาก SECTION 5 ล่างนี้ ไม่ใช่คอลัมน์ contracts ตรงๆ
-- เหมือน credit_history_found) — idempotent: ข้ามถ้ามี key='lock_test_video' อยู่แล้ว
-- ============================================================================

do $$
declare
  v_slots    jsonb;
  v_new_slot jsonb := '{
    "key": "lock_test_video",
    "label": "คลิปเทสล็อกเครื่อง",
    "hint": "ไม่เกิน 10 MB (ประมาณ 1 นาที)",
    "min": 1,
    "max": 1,
    "kind": "video",
    "required": { "when": "flag", "name": "video_required" },
    "sortOrder": 15
  }'::jsonb;
begin
  select value::jsonb into v_slots
  from app_settings
  where key = 'media_slots';

  if v_slots is null then
    raise notice 'ไม่พบ app_settings.media_slots — ข้าม (คาดว่า 0137 ยังไม่ apply)';
    return;
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_slots) e
    where e ->> 'key' = 'lock_test_video'
  ) then
    raise notice 'lock_test_video มีอยู่แล้วใน media_slots — ข้าม (idempotent)';
    return;
  end if;

  update app_settings
  set value = (
    select jsonb_agg(elem order by (elem ->> 'sortOrder')::numeric)::text
    from jsonb_array_elements(v_slots || jsonb_build_array(v_new_slot)) elem
  )
  where key = 'media_slots';
end $$;

-- ============================================================================
-- SECTION 4: seed ค่าตั้งต้นฟีเจอร์คลิป — ปิดไว้ก่อนทั้งหมด (on conflict do nothing ไม่ทับค่าที่แก้ไปแล้ว)
-- ============================================================================

insert into app_settings (key, value, description) values
  ('media_video_required_from', '2099-12-31', 'วันที่เริ่มบังคับแนบคลิปเทสล็อกเครื่อง (lock_test_video) เทียบกับวันที่สร้างสัญญา แบบเดียวกับ media_gate_from — ค่าเริ่มต้นตั้งไกลอนาคต (ปิดฟีเจอร์ไว้ก่อน) จนกว่าคุณเตยจะสั่งเปิด'),
  ('media_video_retention_days', '30', 'จำนวนวันที่เก็บคลิปในเว็บหลังส่งอีเมลบริษัทสำเร็จ (นับจาก contract_media.emailed_at) ก่อน purge job ลบไฟล์จริงออกจาก storage'),
  ('media_video_purge_enabled', 'false', 'true = เปิดให้ purge job ลบไฟล์คลิปจริงตามอายุ (media_video_retention_days) — false = ปิดไว้ก่อนจนกว่าจะทดสอบ purge job เสร็จ (wave ถัดไป)'),
  ('media_video_max_mb', '10', 'ขนาดไฟล์คลิปสูงสุดที่อัปโหลดได้ (MB) ต่อ 1 คลิป (ช่อง lock_test_video)'),
  ('media_email_max_total_mb', '12', 'ขนาดรวมไฟล์แนบสูงสุดต่อ 1 อีเมลบริษัท (รูป+คลิปรวมกัน) กันอีเมลใหญ่เกินที่ SMTP/ผู้รับรับได้')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 5: media_gate_complete — เพิ่ม flag "video_required" คู่กับ credit_history_found เดิม
-- signature เดิมเป๊ะ (p_contract_id uuid) returns boolean — สิทธิ์ execute เดิมจาก 0142 คงอยู่ต่อเนื่อง
-- (CREATE OR REPLACE ไม่ล้าง grant เมื่อ signature ไม่เปลี่ยน) ไม่ต้อง grant execute ซ้ำ
-- ============================================================================

create or replace function public.media_gate_complete(p_contract_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_created_at           timestamptz;
  v_condition            text;
  v_origin               text;
  v_credit_flag          boolean;
  v_email_sent_at        timestamptz;
  v_gate_from            text;
  v_override             boolean;
  v_video_required_from  text;
  v_video_gate_from      date;
  v_video_required       boolean := false;
  v_slots                jsonb;
  v_counts               jsonb;
  v_slot                 jsonb;
  v_required             boolean;
begin
  select created_at, condition, origin, credit_history_found, email_sent_at
    into v_created_at, v_condition, v_origin, v_credit_flag, v_email_sent_at
  from public.contracts
  where id = p_contract_id;

  if not found then
    -- ไม่พบสัญญา — ให้ caller (RPC ที่เรียกฟังก์ชันนี้) เจอ error "ไม่พบสัญญา" จากขั้นตอนอื่นแทน
    return false;
  end if;

  select value into v_gate_from from public.app_settings where key = 'media_gate_from';
  v_gate_from := coalesce(v_gate_from, '2026-09-09');

  if v_created_at is null or (v_created_at at time zone 'utc')::date < v_gate_from::date then
    return true; -- ไม่ gated (สัญญาเก่ากว่า cutoff หรือไม่มี created_at)
  end if;

  select exists(
    select 1 from public.contract_media_gate_override where contract_id = p_contract_id
  ) into v_override;
  if v_override then
    return true; -- แอดมินกดข้ามการตรวจไฟล์ไว้แล้ว (log_media_gate_bypass, 0137)
  end if;

  -- (0154) video_required: setting เป็นวันที่ถูกต้อง (parse ไม่ผ่าน/ว่าง = ไม่บังคับ ห้าม raise) AND
  -- created_at ของสัญญา (UTC date) >= วันนั้น AND contracts.email_sent_at ยังเป็น null (ดู comment
  -- หัวไฟล์ว่าทำไมใช้ email_sent_at ไม่ใช่ contract_media.emailed_at)
  select value into v_video_required_from from public.app_settings where key = 'media_video_required_from';
  if v_video_required_from is not null and btrim(v_video_required_from) <> '' then
    begin
      v_video_gate_from := v_video_required_from::date;
    exception when others then
      v_video_gate_from := null; -- ค่าผิดรูปแบบ — ไม่บังคับ ไม่ raise (ตามที่ตกลง)
    end;
  end if;

  if v_video_gate_from is not null
     and v_created_at is not null
     and (v_created_at at time zone 'utc')::date >= v_video_gate_from
     and v_email_sent_at is null
  then
    v_video_required := true;
  end if;

  select value::jsonb into v_slots from public.app_settings where key = 'media_slots';
  v_slots := coalesce(v_slots, '[]'::jsonb);

  select coalesce(jsonb_object_agg(s.slot_key, s.cnt), '{}'::jsonb) into v_counts
  from (
    select slot_key, count(*) as cnt
    from public.contract_media
    where contract_id = p_contract_id and deleted_at is null
    group by slot_key
  ) s;
  v_counts := coalesce(v_counts, '{}'::jsonb);

  for v_slot in select * from jsonb_array_elements(v_slots)
  loop
    v_required := case
      when v_slot ->> 'required' = 'always' then true
      when v_slot ->> 'required' = 'never' then false
      when jsonb_typeof(v_slot -> 'required') = 'object' and v_slot -> 'required' ->> 'when' = 'condition'
        then v_condition = (v_slot -> 'required' ->> 'equals')
      when jsonb_typeof(v_slot -> 'required') = 'object' and v_slot -> 'required' ->> 'when' = 'flag'
        -- flag ที่รองรับตอนนี้: credit_history_found (0136/0137 slot 13.1), video_required (0154 —
        -- slot lock_test_video) — เพิ่ม flag ใหม่ในอนาคตเติมใน case นี้ได้ ไม่ต้องแก้โครงฟังก์ชัน
        then case (v_slot -> 'required' ->> 'name')
               when 'credit_history_found' then coalesce(v_credit_flag, false)
               when 'video_required' then v_video_required
               else false
             end
      else false
    end;

    if v_required then
      if coalesce((v_counts ->> (v_slot ->> 'key'))::int, 0) < coalesce((v_slot ->> 'min')::int, 0) then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;

comment on function public.media_gate_complete(uuid) is
  '(0142+0154) true = สัญญานี้ผ่านเกณฑ์รูป/คลิปครบ (หรือไม่ถูก gate / แอดมินข้ามการตรวจไว้แล้ว) — mirror evaluateGate ของ send-company-email/index.ts ใช้เป็น guard ของ submit_for_review. 0154 เพิ่ม flag "video_required" (media_video_required_from เทียบ created_at ของสัญญา + contracts.email_sent_at is null) ให้ช่อง lock_test_video บังคับแยกอิสระจากรูปเดิม — ค่า default media_video_required_from=2099-12-31 (ปิดฟีเจอร์) ทำให้ผลลัพธ์เดิมของสัญญาทุกใบไม่เปลี่ยนจนกว่าคุณเตยสั่งเปิด';

-- ============================================================================
-- SECTION 6: email_send_log — เปิดสถานะ 'sending' (ระหว่างส่งจริง ก่อนรู้ผล sent/failed) +
-- attached_media_ids (ผูกไฟล์ที่แนบไปจริงต่ออีเมลแต่ละฉบับ ให้ purge job ใช้ตัดสินว่าไฟล์ไหน "เคยส่งแล้ว")
-- ไม่ hardcode ชื่อ check constraint (0138 ไม่ได้ตั้งชื่อเอง — หาแล้ว drop เองให้ปลอดภัยไม่ว่า Postgres
-- จะตั้งชื่อ auto-gen เป็นอะไรจริง)
-- ============================================================================

do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.email_send_log'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';

  if v_conname is not null then
    execute format('alter table public.email_send_log drop constraint %I', v_conname);
  end if;
end $$;

alter table public.email_send_log
  add constraint email_send_log_status_check
  check (status in ('sending', 'sent', 'failed'));

alter table public.email_send_log
  add column if not exists attached_media_ids uuid[];

comment on column public.email_send_log.attached_media_ids is
  '(0154) รายการ contract_media.id ที่แนบไปกับอีเมลฉบับนี้จริง (รูป+คลิป) — purge job (wave ถัดไป) ใช้ตัดสินว่าไฟล์ไหน "เคยส่งจริง" ก่อนนับอายุ 30 วันจาก contract_media.emailed_at';

-- ============================================================================
-- SECTION 7: ตารางใหม่ media_purge_log — ประวัติ purge job (ยังไม่เขียน job จริงรอบนี้ เตรียม schema ก่อน)
-- เขียนได้ทาง service_role เท่านั้น (pattern เดียวกับ email_send_log 0138 / contract_review_log 0142)
-- admin อ่านได้ผ่าน is_admin() — staff/accounting ไม่ต้องเห็น log การลบไฟล์จริง
-- ============================================================================

create table if not exists public.media_purge_log (
  id            uuid primary key default gen_random_uuid(),
  media_id      uuid not null references public.contract_media (id) on delete cascade,
  contract_id   uuid not null references public.contracts (id) on delete cascade,
  r2_path       text not null,
  bytes         int not null,
  emailed_at    timestamptz,
  purged_at     timestamptz not null default now(),
  result        text not null check (result in ('success', 'failed')),
  error         text
);

create index if not exists media_purge_log_media_idx
  on public.media_purge_log (media_id);

create index if not exists media_purge_log_contract_idx
  on public.media_purge_log (contract_id, purged_at desc);

comment on table public.media_purge_log is
  '(0154) ประวัติ purge job ลบไฟล์คลิปจริงออกจาก storage (สำเร็จ/ล้มเหลว) — เขียนได้ทาง service_role เท่านั้น (pattern เดียวกับ email_send_log 0138), admin อ่านได้อย่างเดียว ห้ามแก้ย้อนหลัง. ไม่มี job จริงเรียกใช้ตารางนี้ในรอบ Wave 1 (schema เท่านั้น)';

alter table public.media_purge_log enable row level security;

drop policy if exists media_purge_log_select on public.media_purge_log;
create policy media_purge_log_select
  on public.media_purge_log
  for select to authenticated
  using (is_admin());

-- ไม่มี insert/update/delete policy สำหรับ authenticated เลย — เขียนได้ทาง service_role (purge job) เท่านั้น

grant select on public.media_purge_log to authenticated;
grant select, insert, update, delete on public.media_purge_log to service_role;

-- ============================================================================
-- SECTION 8 (หมายเหตุ ไม่มีคำสั่ง): ห้ามเพิ่มคอลัมน์ใน public.contracts รอบนี้ตามที่สั่ง — ถ้าจะเพิ่ม
-- ต้องไปแก้ deny-list ของ Guard B ใน 0153 ด้วย ไม่ทำในไฟล์นี้
-- ============================================================================

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) คอลัมน์ใหม่ครบบน contract_media:
-- select column_name, data_type from information_schema.columns
--  where table_name = 'contract_media' and column_name in ('emailed_at', 'purged_at');

-- b) unique index มี purged_at ในนิยามแล้ว (ยังชื่อ contract_media_unique_live เหมือนเดิม):
-- select indexname, indexdef from pg_indexes
--  where schemaname = 'public' and tablename = 'contract_media' and indexname = 'contract_media_unique_live';
-- expected: indexdef มี "purged_at IS NULL" ต่อจาก "deleted_at IS NULL"

-- c) media_slots มี 17 ช่อง (16 เดิม + lock_test_video):
-- select jsonb_array_length(value::jsonb) from app_settings where key = 'media_slots'; -- expected 17
-- select elem from app_settings, jsonb_array_elements(value::jsonb) elem
--  where key = 'media_slots' and elem ->> 'key' = 'lock_test_video';

-- d) settings ใหม่ครบ 5 key:
-- select key, value from app_settings
--  where key in ('media_video_required_from','media_video_retention_days','media_video_purge_enabled',
--                'media_video_max_mb','media_email_max_total_mb');

-- e) email_send_log constraint ยอมรับ 'sending' + คอลัมน์ใหม่:
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.email_send_log'::regclass and contype = 'c';
-- expected: check (status in ('sending','sent','failed'))
-- select column_name from information_schema.columns
--  where table_name = 'email_send_log' and column_name = 'attached_media_ids';

-- f) media_purge_log สร้างสำเร็จ + service_role เขียนได้ (purge job จะพังถ้าไม่ผ่าน):
-- select has_table_privilege('service_role', 'public.media_purge_log', 'INSERT');
-- select has_table_privilege('service_role', 'public.media_purge_log', 'SELECT');
-- select policyname, cmd from pg_policies where tablename = 'media_purge_log';
-- expected: 1 แถว (media_purge_log_select, SELECT)

-- g) media_gate_complete ยังคืนผลเดิมทุกเคส (setting video ปิดอยู่ที่ 2099-12-31) — ดูสคริปต์ทดสอบ
-- แบบ rollback แยกที่ส่งให้ครีมพร้อมรายงานงานนี้ (เก็บผล "ก่อน apply" ไว้เทียบกับ "หลัง apply" แถวต่อแถว)

-- h) ⚠️ ไม่แตะ public.contracts เลยในไฟล์นี้ — เทียบ column list ก่อน/หลังต้องเหมือนเดิมทุกตัว:
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'contracts' order by column_name;
