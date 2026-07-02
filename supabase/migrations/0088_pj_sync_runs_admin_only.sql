-- 0088: ดึงสิทธิ์อ่าน pj_sync_runs (log รอบ auto-sync PJ) กลับเป็น admin เท่านั้น
-- เดิม 0087 ขยาย read ของทั้ง pj_sync_review และ pj_sync_runs จาก is_admin() → is_admin() OR is_staff()
-- Pete สั่งแก้ (2 ก.ค.): staff ควรเห็นเฉพาะ "กล่องรอตรวจ" (pj_sync_review) เท่านั้น
-- ส่วน "log สถานะการดึงยอดอัตโนมัติ" (pj_sync_runs) เป็นเรื่องหลังบ้าน/debug ไม่เกี่ยวงาน staff — re-narrow กลับ admin only
-- ไม่แตะ pj_sync_review เลย (read + update ต้องคง is_admin() OR is_staff() ตาม 0087 — staff ยังต้องกด "ยืนยัน/ข้าม" ในกล่องรอตรวจได้)
-- additive/reversible: drop policy if exists ก่อนสร้างใหม่, ไม่แตะตาราง/คอลัมน์/grant

-- ============================================================================
-- SECTION 1: pj_sync_runs — read กลับเป็น admin only (ชื่อ policy ตรงกับ 0077/0087 เป๊ะ)
-- ============================================================================

drop policy if exists pj_sync_runs_admin_read on public.pj_sync_runs;
create policy pj_sync_runs_admin_read on public.pj_sync_runs
  for select to authenticated
  using (is_admin());

-- หมายเหตุ: ไม่มี policy อื่นบน pj_sync_runs ให้แก้ (insert/update/delete ผ่าน service_role เท่านั้น ตาม 0077 SECTION 5)
-- และไม่แตะ pj_sync_review_admin_read / pj_sync_review_admin_update — คงไว้ตาม 0087 (is_admin() OR is_staff())

-- ============================================================================
-- SECTION 2: Smoke SQL (รันมือหลัง apply ผ่าน MCP)
-- ============================================================================

-- 2a) ดู definition ของ policy ทั้ง 3 ตัว — ตรวจว่า pj_sync_runs_admin_read ไม่มี is_staff() แล้ว
--     ส่วน pj_sync_review_admin_read / pj_sync_review_admin_update ยังมี is_staff() อยู่:
--   select tablename, policyname, cmd, pg_get_expr(polqual, polrelid) as using_expr
--   from pg_policies p
--   join pg_policy pol on pol.polname = p.policyname
--   where p.tablename in ('pj_sync_runs','pj_sync_review')
--   order by p.tablename, p.policyname;
--   -- expected:
--   --   pj_sync_runs   / pj_sync_runs_admin_read     → using_expr มีแค่ is_admin()  (ไม่มี is_staff())
--   --   pj_sync_review / pj_sync_review_admin_read   → using_expr มี is_admin() OR is_staff()
--   --   pj_sync_review / pj_sync_review_admin_update → using_expr มี is_admin() OR is_staff()

-- 2b) นับ policy ต้องยังครบ 3 ตัวเท่าเดิม (ไม่มีเพิ่ม/หาย):
--   select tablename, policyname from pg_policies
--   where tablename in ('pj_sync_runs','pj_sync_review') order by tablename, policyname;
--   -- expected: pj_sync_review_admin_read, pj_sync_review_admin_update, pj_sync_runs_admin_read
