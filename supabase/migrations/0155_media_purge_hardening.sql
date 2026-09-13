-- 0155: เสริมความปลอดภัย schema ก่อนเปิดฟีเจอร์ "ลบคลิปเทสล็อกอัตโนมัติ 30 วันหลังส่งเมล" (Wave 4)
-- เป้าหมาย (schema เท่านั้น — ไม่สร้าง cron/ไม่เปิด purge จริงในไฟล์นี้ ครีมรัน cron.schedule แยกเองหลัง
-- deploy Edge Function media-purge และทดสอบ dry-run 7 วันผ่านตามที่คุณเตยเคาะ):
--   1) media_purge_log.media_id / contract_id → nullable + ON DELETE SET NULL (เดิม CASCADE) — log การลบไฟล์
--      ต้องอยู่ถาวรเป็นหลักฐาน แม้ (ในอนาคต) แถว contract_media หรือ contracts ถูกลบจริงไปแล้ว
--   2) revoke insert/update/delete บน media_purge_log จาก authenticated/anon — defense in depth เพิ่มจาก RLS
--      (Supabase default privileges ให้ authenticated มี INSERT ระดับตารางอยู่แล้วแม้ RLS จะบล็อกจริง)
--   3) partial unique index กันคลิป lock_test_video เกิน 1 ไฟล์ที่ "ยังไม่ถูกลบ/purge" ต่อสัญญา — เขียน
--      guard เช็คข้อมูลซ้ำก่อน ถ้ามีอยู่แล้ว raise notice แล้วข้าม (ไม่ raise error ทำ migration ค้าง)
--   4) find_media_duplicate (0137) เพิ่มกรอง purged_at is null — ไฟล์ที่ถูกลบจริงจาก storage ไปแล้วไม่ควร
--      โผล่เป็น "ไฟล์ซ้ำที่เคยอัปไว้" ให้พนักงานสับสน (path ชี้ไปไฟล์ที่ไม่มีอยู่จริงแล้ว)
--   5) media_purge_candidates(p_retention_days, p_contract_id, p_limit) — SQL function เลือกแถวคลิปที่ครบ
--      เงื่อนไข purge (กรอง review_status ในฝั่ง DB ก่อนตัด limit — กัน starvation ที่ 500 แถวเก่าสุดติด
--      สถานะตรวจหมดแล้วไม่มีอะไรถูกลบเลยทุกวัน) service_role เท่านั้นที่เรียกได้
--   6) verify_media_purge_secret(p_secret) — ตรวจ cron secret ผ่าน Supabase Vault (ไม่ hardcode/ไม่ตั้งเป็น
--      Edge secret) service_role เท่านั้นที่เรียกได้ — ไฟล์นี้ไม่สร้าง vault secret จริง (ครีมรัน
--      vault.create_secret เองแยกหลัง apply ด้วยค่าสุ่มที่ไม่ผ่านแชท)
--   7) ไม่แตะ public.contracts / ไม่สร้างตารางใหม่ / ไม่สร้าง cron / ไม่สร้าง vault secret ในไฟล์นี้
--
-- คำตัดสินเจ้าของ (ล็อก 2026-09-13): ลบเฉพาะคลิป (lock_test_video) ไม่ลบรูปเด็ดขาด, 30 วันหลังส่งเมลบริษัท
-- สำเร็จ ทุกเคสไม่ยกเว้น (โต้แย้ง/ทนาย/คืนเครื่อง), เริ่มด้วย dry-run 7 วันก่อนเปิดลบจริง
--
-- อ้างอิงที่อ่านมาแล้วก่อนเขียนไฟล์นี้: 0017 (grant service_role — media_purge_log inherit อัตโนมัติ),
-- 0136 (contract_media: path/slot_key/storage_provider/deleted_at), 0137 (find_media_duplicate เดิม),
-- 0142 (contracts.review_status: null|'pending_review'|'needs_fix'|'approved'), 0154 (contract_media
-- emailed_at/purged_at + media_purge_log ตารางเดิม + settings media_video_retention_days/purge_enabled)
--
-- Additive + idempotent ทุกคำสั่ง — media_purge_log ยังไม่มีแถวจริงในระบบตอนเขียนไฟล์นี้ (ยังไม่มี purge job
-- เคยรัน) แต่ทุกบล็อกเขียนให้ apply ซ้ำได้ปลอดภัยเผื่ออนาคตมีข้อมูลแล้ว

-- ============================================================================
-- SECTION 1: media_purge_log.media_id / contract_id → nullable + FK เปลี่ยนเป็น ON DELETE SET NULL
-- หาชื่อ constraint จริงผ่าน pg_constraint.conkey (ผูกกับ attnum ของคอลัมน์จริง) ไม่ใช้ ilike ชื่อข้อความ
-- — idempotent: ถ้า FK เป็น ON DELETE SET NULL อยู่แล้ว (confdeltype='n') ข้ามทั้งคู่ไม่ทำอะไรซ้ำ
-- ============================================================================

do $$
declare
  v_media_attnum    smallint;
  v_contract_attnum smallint;
  v_media_fk        record;
  v_contract_fk     record;
begin
  alter table public.media_purge_log alter column media_id drop not null;
  alter table public.media_purge_log alter column contract_id drop not null;

  select attnum into v_media_attnum
  from pg_attribute
  where attrelid = 'public.media_purge_log'::regclass
    and attname = 'media_id' and not attisdropped;

  select attnum into v_contract_attnum
  from pg_attribute
  where attrelid = 'public.media_purge_log'::regclass
    and attname = 'contract_id' and not attisdropped;

  -- FK ที่ชี้ media_id → contract_media(id)
  select conname, confdeltype into v_media_fk
  from pg_constraint
  where conrelid = 'public.media_purge_log'::regclass
    and contype = 'f'
    and confrelid = 'public.contract_media'::regclass
    and conkey = array[v_media_attnum];

  if v_media_fk.confdeltype is distinct from 'n' then
    if v_media_fk.conname is not null then
      execute format('alter table public.media_purge_log drop constraint %I', v_media_fk.conname);
    end if;
    alter table public.media_purge_log
      add constraint media_purge_log_media_id_fkey
      foreign key (media_id) references public.contract_media (id) on delete set null;
    raise notice 'media_purge_log.media_id FK เปลี่ยนเป็น ON DELETE SET NULL แล้ว';
  else
    raise notice 'media_purge_log.media_id FK เป็น ON DELETE SET NULL อยู่แล้ว — ข้าม (idempotent)';
  end if;

  -- FK ที่ชี้ contract_id → contracts(id)
  select conname, confdeltype into v_contract_fk
  from pg_constraint
  where conrelid = 'public.media_purge_log'::regclass
    and contype = 'f'
    and confrelid = 'public.contracts'::regclass
    and conkey = array[v_contract_attnum];

  if v_contract_fk.confdeltype is distinct from 'n' then
    if v_contract_fk.conname is not null then
      execute format('alter table public.media_purge_log drop constraint %I', v_contract_fk.conname);
    end if;
    alter table public.media_purge_log
      add constraint media_purge_log_contract_id_fkey
      foreign key (contract_id) references public.contracts (id) on delete set null;
    raise notice 'media_purge_log.contract_id FK เปลี่ยนเป็น ON DELETE SET NULL แล้ว';
  else
    raise notice 'media_purge_log.contract_id FK เป็น ON DELETE SET NULL อยู่แล้ว — ข้าม (idempotent)';
  end if;
end $$;

comment on column public.media_purge_log.media_id is
  '(0155) nullable, ON DELETE SET NULL (เดิม CASCADE ใน 0154) — แถว log ต้องอยู่ถาวรเป็นหลักฐานแม้ contract_media ถูกลบแถวจริงในอนาคต (ระบบนี้ปกติ soft-delete เท่านั้น แต่กันไว้)';

comment on column public.media_purge_log.contract_id is
  '(0155) nullable, ON DELETE SET NULL (เดิม CASCADE ใน 0154) — แถว log ต้องอยู่ถาวรเป็นหลักฐานแม้ contracts ถูกลบแถวจริงในอนาคต';

-- ============================================================================
-- SECTION 2: revoke insert/update/delete บน media_purge_log จาก authenticated/anon (defense in depth)
-- Supabase ตั้ง default privileges ระดับ database ให้ authenticated/anon มี grant ตารางแทบทุกตัวใน public
-- อยู่แล้ว (คนละเรื่องกับ RLS) — ตารางนี้ต้องเขียนได้ทาง service_role (purge job) เท่านั้น RLS select-only
-- ของ 0154 กันอยู่ชั้นหนึ่งแล้ว แต่ revoke ชั้น grant ตรงๆ ไว้ด้วยกันเผื่อ policy พลาด/ถูกแก้ผิดในอนาคต
-- ============================================================================

revoke insert, update, delete on public.media_purge_log from authenticated, anon;

-- ============================================================================
-- SECTION 3: partial unique index กันคลิป lock_test_video เกิน 1 ไฟล์ "ที่ยังไม่ถูกลบ/purge" ต่อสัญญา
-- เช็คข้อมูลซ้ำก่อนเสมอ — ถ้าเจอซ้ำ (ไม่ควรมีตอนเขียนไฟล์นี้เพราะยังไม่มีแถวคลิปเลยในระบบ) ให้ raise notice
-- แล้วข้าม ไม่ raise error (กัน migration ค้างทั้งไฟล์เพราะ index เดียว)
-- ============================================================================

do $$
declare
  v_dupe_count int;
begin
  select count(*) into v_dupe_count
  from (
    select contract_id
    from public.contract_media
    where slot_key = 'lock_test_video'
      and deleted_at is null
      and purged_at is null
    group by contract_id
    having count(*) > 1
  ) d;

  if v_dupe_count > 0 then
    raise notice 'พบคลิป lock_test_video ซ้ำมากกว่า 1 ไฟล์ (ยังไม่ลบ/purge) ใน % สัญญา — ข้ามการสร้าง unique index รอบนี้ ต้องเคลียร์ข้อมูลซ้ำก่อน (ดู query หาเคสในรายงานที่แนบมากับ migration นี้)', v_dupe_count;
  else
    create unique index if not exists contract_media_video_unique_live
      on public.contract_media (contract_id)
      where slot_key = 'lock_test_video' and deleted_at is null and purged_at is null;

    -- comment ต้องอยู่ในบล็อกนี้ (branch ที่สร้าง index สำเร็จเท่านั้น) — เดิมวางไว้นอก do $$ ทำให้ถ้ามีคลิป
    -- ซ้ำจริง (เข้า branch ข้างบนแทน) index จะไม่ถูกสร้าง แต่ "comment on index" ยังรันต่อนอกบล็อก → error
    -- "relation does not exist" ทำ migration ทั้งไฟล์ล้ม (ติ๊กจับได้ในรีวิว) — ใช้ execute เพราะอยู่ใน plpgsql
    execute format(
      'comment on index public.contract_media_video_unique_live is %L',
      '(0155) กันอัปคลิป lock_test_video เกิน 1 ไฟล์ที่ "ยังมีชีวิต" (ไม่ soft-delete/purge) ต่อสัญญา — ไฟล์เก่าที่ถูก purge ไปแล้ว (purged_at ไม่ null) ไม่ถูกนับ อัปใหม่ทับช่องได้ตามปกติ'
    );

    raise notice 'สร้าง contract_media_video_unique_live สำเร็จ (ไม่พบข้อมูลซ้ำ)';
  end if;
end $$;

-- ============================================================================
-- SECTION 4: find_media_duplicate (0137) เพิ่มกรอง purged_at is null — ไฟล์ที่ purge ไปแล้วไม่ควรถูกชี้ว่า
-- "เคยอัปที่นี่แล้ว" อีก (path ไม่มีไฟล์จริงอยู่แล้ว) — signature/return/security/grants เดิมเป๊ะ (CREATE OR
-- REPLACE ไม่ล้าง grant เมื่อ signature ไม่เปลี่ยน ตาม pattern เดียวกับ 0154 SECTION 5)
--
-- diff เทียบกับของเดิม (0137): เพิ่ม "and cm.purged_at is null" 1 บรรทัดในเงื่อนไข where เท่านั้น
-- ทุกอย่างอื่นเหมือนเดิมทุกตัวอักษร
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
    and cm.purged_at is null
    and (p_exclude_contract_id is null or cm.contract_id <> p_exclude_contract_id)
  order by cm.uploaded_at asc
  limit 1
$$;

comment on function public.find_media_duplicate(text, uuid) is
  '(0137+0155) หาไฟล์ที่เคยอัปที่สัญญาอื่นด้วย sha256 เดียวกัน (คืนแค่ contract_no + ชื่อ mask) — 0155 เพิ่มกรอง purged_at is null กันไฟล์คลิปที่ purge job ลบออกจาก storage ไปแล้วโผล่เป็น "ไฟล์ซ้ำ" หลอกๆ (path ไม่มีไฟล์จริงอยู่แล้ว)';

-- ============================================================================
-- SECTION 5: media_purge_candidates — เลือกแถวคลิปที่ครบเงื่อนไข purge โดยกรอง review_status ในฝั่ง DB
-- ก่อนตัด limit (แก้ starvation ของ media-purge/index.ts เดิม: ดึง 500 แถวเก่าสุดก่อนแล้วค่อยกรองสถานะ
-- ฝั่งแอป — ถ้า 500 แถวแรกติด pending_review/needs_fix หมด จะไม่ลบอะไรเลยทุกวันตลอดไป)
-- SECURITY DEFINER + revoke ทุกสิทธิ์จาก public/anon/authenticated — service_role (Edge Function) เรียก
-- เท่านั้น เพราะคืน path เต็มของไฟล์บน R2 ซึ่งไม่ควรให้ authenticated ทั่วไปเห็นตรงๆ
--
-- retention floor 7 วันบังคับซ้ำที่นี่ (greatest(p_retention_days, 7)) แม้ Edge Function จะ fallback 30
-- วันไปแล้วตอนตั้งค่าผิด — กันกรณีเรียก RPC นี้ตรงๆ ด้วยค่าที่ไม่ผ่าน Edge Function เลย
-- ============================================================================

create or replace function public.media_purge_candidates(
  p_retention_days int,
  p_contract_id     uuid default null,
  p_limit           int  default 50
)
returns table (
  media_id      uuid,
  contract_id   uuid,
  contract_no   text,
  path          text,
  bytes         int,
  emailed_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    cm.id          as media_id,
    cm.contract_id as contract_id,
    c.contract_no  as contract_no,
    cm.path        as path,
    cm.bytes       as bytes,
    cm.emailed_at  as emailed_at
  from public.contract_media cm
  join public.contracts c on c.id = cm.contract_id
  where cm.slot_key = 'lock_test_video'
    and cm.storage_provider = 'r2'
    and cm.deleted_at is null
    and cm.purged_at is null
    and cm.emailed_at is not null
    and cm.emailed_at < now() - make_interval(days => greatest(p_retention_days, 7))
    and (c.review_status is null or c.review_status not in ('pending_review', 'needs_fix'))
    and (p_contract_id is null or cm.contract_id = p_contract_id)
  order by cm.emailed_at asc
  limit least(greatest(p_limit, 1), 50)
$$;

revoke all on function public.media_purge_candidates(int, uuid, int) from public, anon, authenticated;
grant execute on function public.media_purge_candidates(int, uuid, int) to service_role;

comment on function public.media_purge_candidates(int, uuid, int) is
  '(0155) เลือกแถวคลิป lock_test_video ที่ครบเงื่อนไข purge (retention floor 7 วันบังคับที่นี่ด้วย + กรอง review_status pending_review/needs_fix ทิ้งในฝั่ง DB ก่อนตัด limit — กัน starvation ที่ limit ไปติดอยู่กับแถวที่ยังตรวจไม่ผ่านจนไม่เหลือโควต้าให้แถวอื่น) service_role เท่านั้นที่เรียกได้ (revoke จาก public/anon/authenticated) เพราะคืน path จริงบน R2';

-- ============================================================================
-- SECTION 6: verify_media_purge_secret — ตรวจ cron secret ผ่าน Supabase Vault แทนการฝัง Edge secret
-- (MEDIA_PURGE_CRON_SECRET แบบเดิมเทียบใน Deno ตรงๆ) — ไฟล์นี้ไม่สร้าง secret จริงใน vault (ครีมรัน
-- vault.create_secret เองแยกหลัง apply ด้วยค่าสุ่มที่ไม่ผ่านแชท)
--
-- fail-closed ทุกทาง: p_secret ว่าง/null → false, หา secret ชื่อ 'media_purge_cron_secret' ใน vault
-- ไม่เจอ/อ่านไม่ได้ (รวมถึงกรณี extension supabase_vault ยังไม่เปิดใช้ในโปรเจกต์ — exception handler ครอบ
-- ไว้ กันฟังก์ชันสร้างไม่ได้/error ทั้งไฟล์) → false, ความยาวสตริงต่างกัน → false ก่อนเทียบค่า
-- ============================================================================

create or replace function public.verify_media_purge_secret(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v_stored text;
begin
  if p_secret is null or btrim(p_secret) = '' then
    return false;
  end if;

  begin
    select decrypted_secret into v_stored
    from vault.decrypted_secrets
    where name = 'media_purge_cron_secret'
    limit 1;
  exception when others then
    -- extension supabase_vault ยังไม่เปิดใช้ในโปรเจกต์ หรืออ่าน vault ไม่ได้ด้วยเหตุอื่น — fail-closed
    return false;
  end;

  if v_stored is null or btrim(v_stored) = '' then
    return false;
  end if;

  if length(p_secret) <> length(v_stored) then
    return false;
  end if;

  return p_secret = v_stored;
end;
$$;

revoke all on function public.verify_media_purge_secret(text) from public, anon, authenticated;
grant execute on function public.verify_media_purge_secret(text) to service_role;

comment on function public.verify_media_purge_secret(text) is
  '(0155) ตรวจ x-cron-secret ของ media-purge/index.ts เทียบกับ vault.decrypted_secrets (name=''media_purge_cron_secret'') แทนการฝัง Edge secret ตรงๆ — fail-closed ทุกทาง (ว่าง/หา secret ไม่เจอ/extension supabase_vault ยังไม่เปิด/ความยาวต่างกัน → false) service_role เท่านั้นที่เรียกได้ ไฟล์นี้ไม่ได้สร้าง secret จริง (ครีมรัน vault.create_secret แยกเอง)';

-- ============================================================================
-- SECTION 7 (หมายเหตุ ไม่มีคำสั่ง): ไม่สร้าง cron / ไม่สร้าง vault secret ในไฟล์นี้ตามที่สั่ง — SQL
-- cron.schedule (03:30 ไทย = 20:30 UTC, net.http_post + timeout_milliseconds:=25000) และ SQL
-- vault.create_secret อยู่ในรายงานแยกที่ส่งพร้อม migration นี้ ให้ครีมพิจารณา/รันเองหลัง deploy Edge
-- Function media-purge เวอร์ชันใหม่ (เรียก verify_media_purge_secret แทนเทียบ env ตรงๆ) แล้ว
-- ============================================================================

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) FK ทั้งคู่เป็น ON DELETE SET NULL แล้ว + คอลัมน์ nullable:
-- select a.attname, a.attnotnull
-- from pg_attribute a
-- where a.attrelid = 'public.media_purge_log'::regclass
--   and a.attname in ('media_id','contract_id') and not a.attisdropped;
-- -- expected: attnotnull = false ทั้งคู่
--
-- select conname, confdeltype, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.media_purge_log'::regclass and contype = 'f';
-- -- expected: confdeltype = 'n' ทั้ง 2 แถว (media_id, contract_id)

-- b) revoke ผ่านจริง — authenticated ต้อง SELECT ได้แต่ INSERT/UPDATE/DELETE ไม่ได้:
-- select has_table_privilege('authenticated', 'public.media_purge_log', 'SELECT');   -- expected true
-- select has_table_privilege('authenticated', 'public.media_purge_log', 'INSERT');   -- expected false
-- select has_table_privilege('authenticated', 'public.media_purge_log', 'UPDATE');   -- expected false
-- select has_table_privilege('authenticated', 'public.media_purge_log', 'DELETE');   -- expected false
-- select has_table_privilege('service_role', 'public.media_purge_log', 'INSERT');    -- expected true (purge job ต้องเขียนได้)

-- c) unique index สร้างสำเร็จ (ถ้าไม่มีข้อมูลซ้ำตอน apply):
-- select indexname, indexdef from pg_indexes
--  where schemaname = 'public' and tablename = 'contract_media' and indexname = 'contract_media_video_unique_live';

-- d) find_media_duplicate มี purged_at is null ในนิยามแล้ว:
-- select pg_get_functiondef('public.find_media_duplicate(text, uuid)'::regprocedure);
-- -- ค้นหา "purged_at is null" ในผลลัพธ์

-- e) grant execute ของ find_media_duplicate ยังอยู่ครบเหมือนก่อน apply (ไม่ควรเปลี่ยน):
-- select grantee, privilege_type from information_schema.routine_privileges
--  where routine_name = 'find_media_duplicate';
-- -- expected: authenticated + service_role ยังมี EXECUTE เหมือนเดิม

-- f) media_gate_complete (0154) ยังคืนผลเดิมทุกเคส — ไฟล์นี้ไม่แตะฟังก์ชันนั้นเลย ไม่ต้อง re-verify ซ้ำ

-- g) grants ของ 2 ฟังก์ชันใหม่ — service_role execute=true, authenticated/anon execute=false:
-- select has_function_privilege('service_role',   'public.media_purge_candidates(int, uuid, int)', 'EXECUTE'); -- expected true
-- select has_function_privilege('authenticated',  'public.media_purge_candidates(int, uuid, int)', 'EXECUTE'); -- expected false
-- select has_function_privilege('anon',           'public.media_purge_candidates(int, uuid, int)', 'EXECUTE'); -- expected false
-- select has_function_privilege('service_role',   'public.verify_media_purge_secret(text)', 'EXECUTE');        -- expected true
-- select has_function_privilege('authenticated',  'public.verify_media_purge_secret(text)', 'EXECUTE');        -- expected false
-- select has_function_privilege('anon',           'public.verify_media_purge_secret(text)', 'EXECUTE');        -- expected false

-- h) extension supabase_vault มีบนโปรเจกต์ไหม (รันก่อนตัดสินใจ deploy Edge Function เวอร์ชันใหม่ — ถ้าไม่มี
-- verify_media_purge_secret จะ fail-closed คืน false เสมอ ทำให้ทาง x-cron-secret ใช้งานไม่ได้จนกว่าจะเปิด
-- extension นี้ก่อน — ทาง JWT admin ยังใช้ได้ปกติไม่กระทบ):
-- select extname, extversion from pg_extension where extname = 'supabase_vault';
-- -- ถ้าไม่มีแถวเลย = ยังไม่เปิด extension — คุณเตย/ครีมต้องเปิดก่อน (Database > Extensions ใน Studio หรือ MCP)
-- -- แล้วค่อยรัน vault.create_secret('media_purge_cron_secret', '<ค่าสุ่ม>') เอง (ไม่ผ่านแชท)

-- i) เช็คข้อมูลซ้ำก่อน apply จริง (ถ้ามีคลิป lock_test_video ซ้ำ >1 ไฟล์ต่อสัญญาที่ "ยังไม่ลบ/purge" —
-- unique index (SECTION 3) จะถูกข้ามและแค่ raise notice ไม่ fail ทั้งไฟล์ แต่ครีมควรรู้ก่อน apply):
-- select contract_id, count(*)
-- from public.contract_media
-- where slot_key = 'lock_test_video' and deleted_at is null and purged_at is null
-- group by contract_id
-- having count(*) > 1;
-- -- expected: 0 แถว (ไม่มีคลิปซ้ำ) — ถ้ามีแถว ดูรายงานแยกเรื่องวิธีเคลียร์ก่อน apply รอบถัดไป

-- j) rollback test ของ media_purge_candidates — สร้างแถวคลิปทดสอบบนสัญญา TESTQ (ลบทิ้งเองท้าย DO block
-- ไม่ทิ้งข้อมูลปลอมไว้ในฐานจริง) ครอบ 3 เคส: (1) เคสปกติ retention 30 วัน emailed_at ย้อน 35 วัน ต้องถูก
-- เลือก (2) สัญญา needs_fix ต้องไม่ถูกเลือกแม้ครบเงื่อนไขวันอื่นหมด (3) เรียกด้วย p_retention_days=3 (ต่ำกว่า
-- floor 7) ต้องยังถูกดันเป็น 7 วัน (เคสควบคุม emailed_at ย้อน 5 วัน อยู่ในช่วง 3-7 วัน ต้อง "ไม่" ถูกเลือก
-- เพราะ floor บังคับเป็น 7) — DO + raise exception ท้ายบล็อกถ้าผลไม่ตรงคาด (เห็น error ชัดเจนแทนต้องเทียบผล
-- ทีละบรรทัดเอง), ครีมรันในธุรกรรมทดสอบ (BEGIN ... ROLLBACK) ไม่ commit ข้อมูลทดสอบจริง:
--
-- ⚠️ unique index contract_media_video_unique_live (SECTION 3) ยอมให้คลิป lock_test_video ที่ "ยังไม่ลบ/
-- purge" มีได้แค่ 1 แถว/สัญญา — ทดสอบต้องทำทีละเคส (insert → assert → ลบแถวทดสอบทิ้ง) ต่อสัญญาเดียวกัน
-- ไม่ใช่ insert 3 แถวพร้อมกันบนสัญญาเดียว (จะชน unique index ทันที) ทั้งหมดอยู่ใต้ BEGIN..ROLLBACK ข้างนอก
-- อยู่แล้วจึงไม่ต้องกังวลเรื่อง DELETE จริงระหว่างเคส — จบบล็อกคือ rollback ทิ้งทั้งหมดเสมอ:
--
-- begin;
-- do $test$
-- declare
--   v_contract   uuid;
--   v_media      uuid;
--   v_hit        boolean;
-- begin
--   select id into v_contract from public.contracts where contract_no like 'TESTQ-%' limit 1;
--   if v_contract is null then
--     raise exception 'ไม่พบสัญญา TESTQ ใดๆ ในฐาน — หาสัญญา TESTQ อื่นมาใช้ทดสอบแทน หรือสร้างสัญญา TESTQ ชั่วคราวก่อนรัน';
--   end if;
--
--   -- กันพลาด: เผื่อสัญญาที่สุ่มได้ดันมี review_status ค้างอยู่ก่อนแล้ว ตั้ง null ให้ชัดก่อนเริ่มเคส 1/3
--   update public.contracts set review_status = null where id = v_contract;
--
--   -- ── เคส (1) retention ปกติ 30 วัน, emailed_at ย้อน 35 วัน — ต้องถูกเลือก ──────────────────────────
--   -- sha256 เป็น not null (0136) — ใส่ค่าปลอมที่ไม่ซ้ำกันพอผ่าน constraint (ไม่ใช้เทียบไฟล์จริง)
--   insert into public.contract_media (id, contract_id, slot_key, storage_provider, path, bytes, sha256, deleted_at, purged_at, emailed_at, uploaded_at)
--   values (gen_random_uuid(), v_contract, 'lock_test_video', 'r2', 'test/rollback-ok.mp4', 1000, 'rollbacktest-ok', null, null, now() - interval '35 days', now())
--   returning id into v_media;
--
--   select exists(select 1 from public.media_purge_candidates(30, v_contract, 50) where media_id = v_media) into v_hit;
--   if not v_hit then
--     raise exception 'FAIL เคส 1: คลิปที่ครบเงื่อนไข 35 วัน (retention 30) ไม่ถูกเลือก — ควรถูกเลือก';
--   end if;
--
--   delete from public.contract_media where id = v_media; -- เคลียร์ก่อนเคสถัดไป (unique index อนุญาตแค่ 1 แถวเป็นอยู่/สัญญา)
--
--   -- ── เคส (2) สัญญา needs_fix ต้องไม่ถูกเลือกแม้ครบเงื่อนไขวันอื่นหมด (emailed_at ย้อน 40 วัน) ────────
--   update public.contracts set review_status = 'needs_fix' where id = v_contract;
--
--   insert into public.contract_media (id, contract_id, slot_key, storage_provider, path, bytes, sha256, deleted_at, purged_at, emailed_at, uploaded_at)
--   values (gen_random_uuid(), v_contract, 'lock_test_video', 'r2', 'test/rollback-needsfix.mp4', 1000, 'rollbacktest-needsfix', null, null, now() - interval '40 days', now())
--   returning id into v_media;
--
--   select exists(select 1 from public.media_purge_candidates(30, v_contract, 50) where media_id = v_media) into v_hit;
--   if v_hit then
--     raise exception 'FAIL เคส 2: สัญญา needs_fix ถูกเลือกเป็น candidate — ต้องไม่ถูกเลือก';
--   end if;
--
--   delete from public.contract_media where id = v_media;
--   update public.contracts set review_status = null where id = v_contract; -- reset ก่อนเคสถัดไป
--
--   -- ── เคส (3) retention 3 วัน (ต่ำกว่า floor 7) ต้องถูกดันเป็น 7 — emailed_at ย้อนแค่ 5 วัน (อยู่ในช่วง
--   -- 3-7 วัน) ต้อง "ไม่" ถูกเลือก เพราะ floor บังคับเป็น 7 วันเสมอไม่ว่า p_retention_days จะส่งมาเท่าไหร่ ──
--   insert into public.contract_media (id, contract_id, slot_key, storage_provider, path, bytes, sha256, deleted_at, purged_at, emailed_at, uploaded_at)
--   values (gen_random_uuid(), v_contract, 'lock_test_video', 'r2', 'test/rollback-floor.mp4', 1000, 'rollbacktest-floor', null, null, now() - interval '5 days', now())
--   returning id into v_media;
--
--   select exists(select 1 from public.media_purge_candidates(3, v_contract, 50) where media_id = v_media) into v_hit;
--   if v_hit then
--     raise exception 'FAIL เคส 3: เรียกด้วย p_retention_days=3 แต่คลิปอายุแค่ 5 วันถูกเลือก — floor 7 วันไม่ทำงาน';
--   end if;
--
--   delete from public.contract_media where id = v_media;
--
--   raise notice 'PASS ทั้ง 3 เคส: media_purge_candidates ทำงานถูกต้อง (retention ปกติ + review_status block + retention floor 7)';
-- end $test$;
-- rollback; -- สำคัญ: ต้อง rollback เสมอ ไม่ commit ข้อมูลทดสอบ (แถวคลิปทดสอบ + review_status ชั่วคราว) เข้าฐานจริง
