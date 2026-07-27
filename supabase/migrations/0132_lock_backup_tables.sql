-- 0132: ปิดรู RLS ของตาราง backup/audit (ชื่อขึ้นต้น _) + ตาราง PJ dedup (pj_applied_receipts, pj_applied_ledger)
-- ที่มา: Supabase advisor เจอ 186 ตารางใน public เปิด RLS ไม่ครบ. ตรวจ grant จริงแล้วพบว่า:
--   - anon มีสิทธิ์ TRUNCATE บนตาราง backup 185 ตัว (ไม่มี SELECT/DML) → กด publishable key ลบข้อมูล backup ได้
--   - authenticated มีสิทธิ์ SELECT/INSERT/UPDATE/DELETE เต็มบนทั้ง 186 ตัว (RLS ปิด = ไม่มีอะไรกรอง)
--     → พนักงาน/ฟรีแลนซ์ที่ล็อกอินอยู่ อ่าน/แก้ตาราง backup ที่มีข้อมูลลูกค้า (PII) ได้หมด
--   - service_role และ postgres มี rolbypassrls = true อยู่แล้ว → เปิด RLS รอบนี้ไม่กระทบ Edge Function/MCP
--
-- แนวทาง 3 กลุ่ม:
--   A) ตาราง backup/audit (_bk*, _fix_*, _penalty_backup_*, ฯลฯ ~184 ตาราง) — เอา anon/authenticated ออกหมด,
--      เปิด RLS ไม่มี policy เลย (เข้าได้เฉพาะ service_role/postgres) — ไม่มีที่ไหนใน src/**, supabase/functions/**
--      เรียกตารางกลุ่มนี้ตรงๆ เลย ปลอดภัยที่จะล็อกทิ้ง
--   B) pj_applied_receipts — ตาราง dedup ที่เขียนจาก pj-sync Edge Function (service_role) และ RPC
--      SECURITY DEFINER เท่านั้น ไม่มี supabase.from('pj_applied_receipts') จาก frontend เลย (ครีมเช็ค grep แล้ว
--      เจอแค่ comment อ้างถึงชื่อตาราง ไม่มีเรียกจริง) → ล็อกเหมือนกลุ่ม A ได้
--   C) pj_applied_ledger — ตารางเดียวที่ frontend เขียนตรง (src/lib/db.ts upsert ในหน้ากล่องรอตรวจ PJ)
--      ล็อกแบบเบากว่า: ตัด anon ออกทั้งหมด, authenticated เหลือแค่ SELECT/INSERT/UPDATE (ตัด DELETE/TRUNCATE/
--      REFERENCES/TRIGGER ที่เกินจำเป็นออก) แล้วคุม RLS ด้วย policy admin-OR-staff (is_admin() OR is_staff())
--      🔧 แก้จากดราฟต์แรก (admin-only): หน้า /pj-sync-review gate ด้วย isAdminOrStaff (App.tsx) และ 0087 เปิด
--      read/update pj_sync_review ให้ staff แล้ว — ถ้า pj_applied_ledger ล็อก admin-only เฉยๆ จะทำให้ staff
--      ยืนยันเคสได้ตามปกติ (RPC + resolvePjReviewItem ผ่านหมด) แต่ upsert ledger กันซ้ำ (db.ts:8348) โดน RLS
--      บล็อกเงียบๆ (ห่อ try/catch best-effort) → dedup อ่อนลงแบบไม่มีใครเห็น เตยสั่งแก้ไม่ให้เกิดเคสนี้
--      ใช้ is_admin() OR is_staff() ตัวเดิมจาก 0087_pj_review_staff_access.sql ตรงตัว ไม่ประดิษฐ์ predicate ใหม่ —
--      is_staff() (0022) เช็ค role='staff' AND active=true ตรงๆ จึงกันบัญชี freelancer/executive/accounting
--      ไม่ให้เขียนได้ "โดยโครงสร้าง" (role ต้อง = 'staff' เป๊ะ ไม่ใช่กันด้วยการไม่เขียน policy ให้)
--
-- Additive/idempotent: revoke ที่ไม่มีสิทธิ์อยู่แล้ว = no-op, enable row level security รันซ้ำได้,
-- drop policy if exists ก่อน create ทุกครั้ง — รันซ้ำได้ปลอดภัย ไม่แตะตาราง live อื่นนอกจาก 2 ตัวที่ระบุ (B, C)

-- ============================================================================
-- SECTION 1 (Group A): ตาราง backup/audit ที่ชื่อขึ้นต้นด้วย _ — ล็อกทั้งหมดแบบไม่มี policy
-- ============================================================================

do $$
declare
  t record;
begin
  for t in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename like '\_%'
  loop
    execute format('revoke all on table public.%I from anon', t.tablename);
    execute format('revoke all on table public.%I from authenticated', t.tablename);
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ============================================================================
-- SECTION 2 (Group B): pj_applied_receipts — dedup table เขียนจาก service_role/SECURITY DEFINER เท่านั้น
-- ============================================================================

do $$
begin
  if to_regclass('public.pj_applied_receipts') is not null then
    revoke all on table public.pj_applied_receipts from anon;
    revoke all on table public.pj_applied_receipts from authenticated;
    alter table public.pj_applied_receipts enable row level security;
  end if;
end $$;

-- ============================================================================
-- SECTION 3 (Group C): pj_applied_ledger — เขียนจาก frontend (กล่องรอตรวจ PJ) จำกัดสิทธิ์ + RLS admin-or-staff
-- ============================================================================

do $$
begin
  if to_regclass('public.pj_applied_ledger') is not null then
    revoke all on table public.pj_applied_ledger from anon;
    revoke all on table public.pj_applied_ledger from authenticated;
    -- คงไว้เฉพาะคำสั่งที่ frontend ใช้จริง: upsert = insert + update, ต้อง select อ่านกลับด้วย (PostgREST upsert)
    grant select, insert, update on table public.pj_applied_ledger to authenticated;
    alter table public.pj_applied_ledger enable row level security;
  end if;
end $$;

-- predicate ตรงกับ 0087_pj_review_staff_access.sql เป๊ะ (is_admin() OR is_staff()) — ไม่ประดิษฐ์ใหม่
drop policy if exists pj_applied_ledger_admin_staff_select on public.pj_applied_ledger;
create policy pj_applied_ledger_admin_staff_select on public.pj_applied_ledger
  for select to authenticated
  using (is_admin() OR is_staff());

drop policy if exists pj_applied_ledger_admin_staff_insert on public.pj_applied_ledger;
create policy pj_applied_ledger_admin_staff_insert on public.pj_applied_ledger
  for insert to authenticated
  with check (is_admin() OR is_staff());

drop policy if exists pj_applied_ledger_admin_staff_update on public.pj_applied_ledger;
create policy pj_applied_ledger_admin_staff_update on public.pj_applied_ledger
  for update to authenticated
  using (is_admin() OR is_staff())
  with check (is_admin() OR is_staff());

-- ============================================================================
-- SECTION 4: Smoke SQL (รันมือหลัง apply ผ่าน MCP — ดูรายละเอียดเพิ่มในรายงานของน้องชีส)
-- ============================================================================

-- 4a) authenticated ต้องไม่มี SELECT บนตาราง backup อีกต่อไป (คาดหวัง: false ทุกแถว)
--   select tablename, has_table_privilege('authenticated', 'public.' || tablename, 'SELECT') as can_select
--   from pg_tables where schemaname = 'public' and tablename like '\_%'
--   order by tablename;

-- 4b) pj_applied_ledger: authenticated ต้องมี select/insert/update แต่ไม่มี delete
--   select
--     has_table_privilege('authenticated', 'public.pj_applied_ledger', 'SELECT') as can_select,
--     has_table_privilege('authenticated', 'public.pj_applied_ledger', 'INSERT') as can_insert,
--     has_table_privilege('authenticated', 'public.pj_applied_ledger', 'UPDATE') as can_update,
--     has_table_privilege('authenticated', 'public.pj_applied_ledger', 'DELETE') as can_delete;
--   -- expected: true, true, true, false

-- 4c) RLS เปิดจริงบนทั้ง 3 กลุ่ม (relrowsecurity = true ทุกแถว)
--   select c.relname, c.relrowsecurity
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public'
--     and (c.relname like '\_%' or c.relname in ('pj_applied_receipts', 'pj_applied_ledger'))
--   order by c.relname;

-- 4d) per-role write test บน pj_applied_ledger — จำลอง auth.uid() ของ staff จริง 1 คน + freelancer จริง 1 คน
--   หา id มาก่อน: select id, full_name, role, active from profiles where role in ('staff','freelancer') and active limit 5;
--   แล้วรันทีละ block (แต่ละ block self-contained, rollback เอง ไม่ทิ้งรอยในตาราง):
--
--   -- (i) staff ต้อง INSERT ผ่าน (คาดหวัง: no error, แถวถูก insert ใน tx นี้)
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<uuid ของ staff>","role":"authenticated"}';
--     insert into public.pj_applied_ledger (contract_id, pj_paid_date, inst_amount, pen_amount, source, applied_at)
--     select id, current_date, 0, 0, 'smoke-test-staff', now() from public.contracts limit 1
--     on conflict (contract_id, pj_paid_date) do nothing;
--   rollback;
--
--   -- (ii) freelancer ต้องโดน RLS ปฏิเสธ (คาดหวัง: error "new row violates row-level security policy")
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<uuid ของ freelancer>","role":"authenticated"}';
--     insert into public.pj_applied_ledger (contract_id, pj_paid_date, inst_amount, pen_amount, source, applied_at)
--     select id, current_date, 0, 0, 'smoke-test-freelancer', now() from public.contracts limit 1
--     on conflict (contract_id, pj_paid_date) do nothing;
--   rollback;
