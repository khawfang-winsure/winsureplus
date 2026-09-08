-- 0136: ตารางเก็บรูปเอกสารแนบต่อสัญญา (contract_media) + bucket private สำหรับไฟล์
-- เป้าหมาย: เก็บรูปหลักฐาน 14 ช่อง (บัตร, รอบตัวเครื่อง, เอกสารเซ็น, ผลเช็คเครดิต ฯลฯ) ต่อสัญญา
-- ก่อนส่งอีเมลให้บริษัท (ดู 0137/0138 คู่กัน) — Wave 1 ของแผน media attachments (2026-09-08)
-- อ้างอิง pattern bucket+RLS จาก 0083 (shop_transfer/transfer-slips) และ freelancer predicate จาก 0110
-- Additive ทั้งหมด — ไม่แตะตารางเดิม นอกจากเพิ่มคอลัมน์ credit_history_found บน contracts

-- ============================================================================
-- SECTION 1: เพิ่มคอลัมน์ credit_history_found บน contracts (ธงเช็คว่าพบประวัติเครดิตเสีย)
-- ใช้เป็น flag ให้ evaluateSlots (media.ts) เปิดช่อง "ใบแจ้งความ/หลักฐานเคลียร์ยอด" (13.1)
-- ============================================================================

alter table public.contracts
  add column if not exists credit_history_found boolean not null default false;

comment on column public.contracts.credit_history_found is
  'ธงว่าตรวจพบประวัติเครดิตเสียของลูกค้า (ติ๊กที่ช่องผลเช็คเครดิต) — เปิดช่องแนบ "ใบแจ้งความ/หลักฐานเคลียร์ยอด" (0136/media.ts slot 13.1)';

-- ============================================================================
-- SECTION 2: ตาราง contract_media — 1 แถวต่อไฟล์แนบ
-- ============================================================================

create table if not exists public.contract_media (
  id                uuid primary key default gen_random_uuid(),
  contract_id       uuid not null references public.contracts (id) on delete cascade,
  slot_key          text not null,                          -- key จาก app_settings.media_slots (0137)
  storage_provider  text not null default 'supabase',        -- 'supabase' | 'r2' (เผื่อย้ายไป R2 ทีหลัง — wave 6)
  path              text not null,                           -- path ใน bucket/พื้นที่เก็บของ provider นั้น
  bytes             int not null,
  sha256            text not null,                           -- ใช้เช็คไฟล์ซ้ำ (ในสัญญาเดียวกัน/ข้ามสัญญา)
  width             int,
  height            int,
  mime              text,
  uploaded_by       uuid references auth.users (id) on delete set null,
  uploaded_at       timestamptz not null default now(),
  deleted_at        timestamptz,                             -- soft delete เท่านั้น (ไม่มี DELETE policy จริง)
  deleted_by        uuid references auth.users (id) on delete set null,
  dup_confirmed     boolean not null default false            -- true = admin/staff ยืนยันแล้วว่ารูปซ้ำข้ามสัญญาถูกต้อง ไม่ใช่คีย์ผิด
);

create index if not exists contract_media_contract_idx
  on public.contract_media (contract_id) where deleted_at is null;

create index if not exists contract_media_sha256_idx
  on public.contract_media (sha256);

comment on table public.contract_media is
  'รูปเอกสารแนบต่อสัญญา (บัตรประชาชน, รอบตัวเครื่อง, เอกสารเซ็น, ผลเช็คเครดิต ฯลฯ) — ใช้ประกอบก่อนส่งอีเมลเอกสารให้บริษัท (0137/0138). soft-delete เท่านั้น ไม่มี DELETE policy จริง';

-- ============================================================================
-- SECTION 3: RLS contract_media
-- SELECT: admin/staff/accounting เห็นหมด + freelancer เห็นเฉพาะสัญญาที่ตรง scope (grade/assigned)
--         ใช้ predicate เดียวกับ follow_ups_read ใน 0110 เป๊ะ (status active/returned)
-- INSERT: admin/staff เท่านั้น (media ถ่ายตอนทำสัญญา — freelancer ไม่ได้อัปตอนนี้ ตาม wave plan, ไม่ widen)
-- UPDATE: admin เท่านั้น (soft delete / ยืนยันไฟล์ซ้ำ)
-- ไม่มี DELETE policy เลย
-- ============================================================================

alter table public.contract_media enable row level security;

drop policy if exists contract_media_select on public.contract_media;
create policy contract_media_select
  on public.contract_media
  as permissive
  for select
  to authenticated
  using (
    is_admin()
    or is_staff()
    or is_accounting()
    or (
      is_freelancer()
      and exists (
        select 1
        from public.contracts c
        where c.id = contract_media.contract_id
          and c.status in ('active', 'returned')
          and (
            (c.current_grade is not null and freelancer_has_grade(c.current_grade))
            or c.assigned_to = auth.uid()
          )
      )
    )
  );

drop policy if exists contract_media_insert on public.contract_media;
create policy contract_media_insert
  on public.contract_media
  as permissive
  for insert
  to authenticated
  with check (is_admin() or is_staff());

drop policy if exists contract_media_update on public.contract_media;
create policy contract_media_update
  on public.contract_media
  as permissive
  for update
  to authenticated
  using (is_admin())
  with check (is_admin());

-- ============================================================================
-- SECTION 4: GRANT service_role (0017 ALTER DEFAULT PRIVILEGES ครอบอยู่แล้ว — เพิ่ม explicit เพื่อความชัดเจน/audit)
-- ============================================================================

grant select, insert, update, delete on public.contract_media to service_role;
grant select, insert, update on public.contract_media to authenticated;

-- ============================================================================
-- SECTION 5: Storage bucket contract-media (private — public=false, จำกัดชนิด/ขนาดไฟล์)
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contract-media', 'contract-media', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- ============================================================================
-- SECTION 6: Storage RLS บน storage.objects เฉพาะ bucket contract-media
-- path convention: '<contract_id>/<slot_key>/<uuid>.jpg' (ดู uploadMedia ใน db.ts)
-- ใช้ split_part(name,'/',1) ดึง contract_id ออกมาเทียบ scope เดียวกับ policy บนตาราง
-- SELECT/INSERT: ตรงกับ policy บนตาราง (admin/staff/accounting + freelancer scoped)
-- UPDATE/DELETE: admin เท่านั้น
-- เรียก public.is_xxx()/freelancer_has_grade แบบ schema-qualified ตรงๆ (ไม่พึ่ง search_path ของ session
--   ที่ query storage.objects — กันความกำกวมข้ามสคีมา ตาม pattern 0083)
-- ============================================================================

drop policy if exists contract_media_objects_select on storage.objects;
create policy contract_media_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'contract-media'
    and (
      public.is_admin()
      or public.is_staff()
      or public.is_accounting()
      or (
        public.is_freelancer()
        and exists (
          select 1
          from public.contracts c
          where c.id::text = split_part(storage.objects.name, '/', 1)
            and c.status in ('active', 'returned')
            and (
              (c.current_grade is not null and public.freelancer_has_grade(c.current_grade))
              or c.assigned_to = auth.uid()
            )
        )
      )
    )
  );

drop policy if exists contract_media_objects_insert on storage.objects;
create policy contract_media_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'contract-media'
    and (public.is_admin() or public.is_staff())
  );

drop policy if exists contract_media_objects_update on storage.objects;
create policy contract_media_objects_update on storage.objects
  for update to authenticated
  using (bucket_id = 'contract-media' and public.is_admin())
  with check (bucket_id = 'contract-media' and public.is_admin());

drop policy if exists contract_media_objects_delete on storage.objects;
create policy contract_media_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'contract-media' and public.is_admin());

-- ============================================================================
-- SECTION 7: Smoke SQL (รันมือหลัง apply เพื่อ verify — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================
-- 1) service_role เขียน/อ่าน contract_media ได้ (Edge Function จะพังถ้าไม่ผ่าน):
-- SELECT has_table_privilege('service_role', 'public.contract_media', 'SELECT');
-- SELECT has_table_privilege('service_role', 'public.contract_media', 'INSERT');
-- SELECT has_table_privilege('service_role', 'public.contract_media', 'UPDATE');
--
-- 2) bucket สร้างสำเร็จ + private + limit ถูกต้อง:
-- SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'contract-media';
-- expected: public = false, file_size_limit = 8388608
--
-- 3) policy ครบบน contract_media (3: select/insert/update) + storage.objects (4: select/insert/update/delete):
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'contract_media' ORDER BY policyname;
-- SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'contract_media_objects_%';
--
-- 4) คอลัมน์ credit_history_found เพิ่มสำเร็จ:
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_name = 'contracts' AND column_name = 'credit_history_found';
