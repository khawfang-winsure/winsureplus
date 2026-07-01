-- 0083: ตาราง shop_transfer + role 'accounting' + bucket สลิปโอนร้าน (transfer-slips, private)
-- เป้าหมาย: วางฐานหลังบ้านให้ทีมบัญชีดูยอดโอนรายวัน/ร้าน + แนบสลิป โดยไม่แตะตาราง contracts เดิม
-- ยึด pattern role เดิม (0018/0026): widen profiles_role_check + is_xxx() SECURITY DEFINER helper
-- ยอดโอนไม่ได้คีย์ซ้ำในตารางนี้ — คำนวณฝั่งแอปจาก contracts (net_transfer) แล้วค่อย mark ว่าโอนแล้ว
-- Additive ทั้งหมด — ไม่แตะ/ลบของเดิม

-- ============================================================================
-- SECTION 1: widen profiles_role_check ให้รองรับ 'accounting'
-- Drop + re-add (safe — ยังไม่มีแถวไหนใช้ค่านี้) ต้องรวมทุกค่าจากไฟล์ก่อนหน้า (0018/0026)
-- ============================================================================

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'staff', 'freelancer', 'executive', 'accounting'));

-- ============================================================================
-- SECTION 2: helper function is_accounting()
-- Pattern เดียวกับ is_admin()/is_staff()/is_freelancer()/is_executive()
-- SECURITY DEFINER กัน infinite recursion (policy → subquery profiles → policy)
-- ============================================================================

create or replace function public.is_accounting()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'accounting'
      and active = true
  );
$$;

grant execute on function public.is_accounting() to authenticated, service_role;

-- ============================================================================
-- SECTION 3: ตาราง shop_transfer — 1 แถว/ร้าน/วัน
-- amount = snapshot ยอดตอน mark โอน (คำนวณจาก contracts.net_transfer ฝั่งแอป ไม่ derive ในตาราง
--   เพราะยอดต้องคงที่แม้สัญญาถูกแก้ย้อนหลัง — เป็นหลักฐานการโอนจริง ณ วันนั้น)
-- ============================================================================

create table if not exists public.shop_transfer (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops (id),
  transfer_date   date not null,
  amount          numeric not null default 0,
  transferred     boolean not null default false,
  slip_path       text,                         -- path ใน bucket transfer-slips (private)
  transferred_by  text,                          -- ชื่อคนกดโอน (snapshot ข้อความ ไม่ผูก FK)
  transferred_at  timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  unique (shop_id, transfer_date)
);

create index if not exists shop_transfer_date_idx on public.shop_transfer (transfer_date);
create index if not exists shop_transfer_shop_idx on public.shop_transfer (shop_id);

comment on table public.shop_transfer is 'สถานะโอนเงินให้ร้านรายวัน (1 แถว/ร้าน/วัน) — ยอดคำนวณจาก contracts ฝั่งแอป, ตารางนี้เก็บสถานะ+สลิปเท่านั้น';
comment on column public.shop_transfer.slip_path is 'path ใน storage bucket transfer-slips (private) — เปิดได้เฉพาะ admin/accounting ผ่าน signed URL';

-- ============================================================================
-- SECTION 4: RLS shop_transfer
-- อ่าน/เขียน (insert+update): admin + accounting เท่านั้น. staff/freelancer/executive ไม่ได้
-- ห้าม DELETE ทุก role ผ่าน RLS ปกติ (ไม่มี policy FOR DELETE = ปิดสนิท แม้ admin ก็ผ่านทาง service_role/Studio เท่านั้น)
-- "accounting แก้ได้แต่ห้าม un-transfer/ลบ slip" คุมที่ db.ts (markShopTransferred เท่านั้น, ไม่มี unmark/deleteSlip
--   export ให้ accounting เรียก) — RLS ระดับคอลัมน์แยก transferred=true→false ทำยาก จึงคุมชั้นแอปตามที่ Pete ระบุ
-- ============================================================================

alter table public.shop_transfer enable row level security;

drop policy if exists shop_transfer_read on public.shop_transfer;
create policy shop_transfer_read on public.shop_transfer
  for select to authenticated
  using (is_admin() OR is_accounting());

drop policy if exists shop_transfer_insert on public.shop_transfer;
create policy shop_transfer_insert on public.shop_transfer
  for insert to authenticated
  with check (is_admin() OR is_accounting());

drop policy if exists shop_transfer_update on public.shop_transfer;
create policy shop_transfer_update on public.shop_transfer
  for update to authenticated
  using (is_admin() OR is_accounting())
  with check (is_admin() OR is_accounting());

-- ไม่มี policy FOR DELETE — ไม่มีใคร (แม้ admin) ลบผ่าน authenticated role ได้
-- ถ้าต้องลบจริง (ข้อมูลผิดพลาด) ให้ admin ทำผ่าน service_role/SQL Editor เป็นกรณีพิเศษ

-- ============================================================================
-- SECTION 5: GRANT service_role (0017 ALTER DEFAULT PRIVILEGES ครอบอยู่แล้ว — เพิ่ม explicit เพื่อความชัดเจน/audit)
-- ============================================================================

grant select, insert, update, delete on public.shop_transfer to service_role;

-- ============================================================================
-- SECTION 6: Storage bucket transfer-slips (private — public=false)
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('transfer-slips', 'transfer-slips', false)
on conflict (id) do nothing;

-- ============================================================================
-- SECTION 7: Storage RLS บน storage.objects เฉพาะ bucket transfer-slips
-- SELECT/INSERT/UPDATE: admin + accounting เท่านั้น. ไม่มี public read (ร้านค้าไม่เห็น)
-- DELETE: เฉพาะ admin (accounting ลบสลิปไม่ได้ — กันหลักฐานหาย ตาม Pete lock)
-- ============================================================================

-- หมายเหตุ: เรียก public.is_admin()/public.is_accounting() แบบ schema-qualified ตรงๆ
-- (ไม่พึ่ง search_path ของ session ที่ query storage.objects — กันความกำกวมข้ามสคีมา)

drop policy if exists transfer_slips_select on storage.objects;
create policy transfer_slips_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'transfer-slips'
    AND (public.is_admin() OR public.is_accounting())
  );

drop policy if exists transfer_slips_insert on storage.objects;
create policy transfer_slips_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'transfer-slips'
    AND (public.is_admin() OR public.is_accounting())
  );

drop policy if exists transfer_slips_update on storage.objects;
create policy transfer_slips_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'transfer-slips'
    AND (public.is_admin() OR public.is_accounting())
  )
  with check (
    bucket_id = 'transfer-slips'
    AND (public.is_admin() OR public.is_accounting())
  );

drop policy if exists transfer_slips_delete on storage.objects;
create policy transfer_slips_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'transfer-slips'
    AND public.is_admin()
  );

-- ============================================================================
-- SECTION 8: Smoke SQL (รันมือหลัง apply เพื่อ verify — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================
-- 1) constraint กว้างพอ:
-- SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
--   JOIN pg_class r ON r.oid = c.conrelid
--   WHERE c.conname = 'profiles_role_check' AND r.relname = 'profiles';
-- expected: contains 'accounting'
--
-- 2) service_role เขียน shop_transfer ได้ (Edge Function จะพังถ้าไม่ผ่าน):
-- SELECT has_table_privilege('service_role', 'public.shop_transfer', 'SELECT');
-- SELECT has_table_privilege('service_role', 'public.shop_transfer', 'INSERT');
--
-- 3) bucket สร้างสำเร็จ + private:
-- SELECT id, public FROM storage.buckets WHERE id = 'transfer-slips';
-- expected: public = false
--
-- 4) policy ครบ 4 ตัวบน storage.objects:
-- SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'transfer_slips_%';
-- expected: 4 rows (select/insert/update/delete)
