-- 0087: ขยายสิทธิ์กล่องรอตรวจ PJ (pj_sync_review) + log รอบ sync (pj_sync_runs) ให้ staff ใช้ได้ ไม่ใช่แค่ admin
-- เดิม (0077) RLS จำกัดแค่ is_admin() — Pete ต้องการให้ staff ช่วยยืนยัน/ข้ามเคสในกล่องรอตรวจได้ด้วย
-- additive: drop policy if exists ก่อนสร้างใหม่ (ชื่อ policy ตรงกับ 0077 เป๊ะ), ไม่แตะตาราง/คอลัมน์

-- ============================================================================
-- SECTION 1: pj_sync_runs — read ขยายจาก admin-only → admin หรือ staff
-- ============================================================================

drop policy if exists pj_sync_runs_admin_read on public.pj_sync_runs;
create policy pj_sync_runs_admin_read on public.pj_sync_runs
  for select to authenticated
  using (is_admin() OR is_staff());

-- ============================================================================
-- SECTION 2: pj_sync_review — read + update ขยายจาก admin-only → admin หรือ staff
-- ============================================================================

drop policy if exists pj_sync_review_admin_read on public.pj_sync_review;
create policy pj_sync_review_admin_read on public.pj_sync_review
  for select to authenticated
  using (is_admin() OR is_staff());

drop policy if exists pj_sync_review_admin_update on public.pj_sync_review;
create policy pj_sync_review_admin_update on public.pj_sync_review
  for update to authenticated
  using (is_admin() OR is_staff())
  with check (is_admin() OR is_staff());

-- ============================================================================
-- SECTION 3: RPC ที่หน้ากล่องรอตรวจเรียกตอน "ยืนยันลงยอด" — ตรวจแล้ว ไม่มี guard admin-only ภายใน
-- ============================================================================
-- PjSyncReview.tsx (applyPjReviewPayment ใน db.ts) เรียก:
--   1) rpc('record_payment_spread', ...) — mig 0079: grant execute ให้ authenticated (ไม่มี is_admin() ภายใน) → staff เรียกได้อยู่แล้ว ไม่ต้องแก้
--   2) update public.pj_sync_review (resolvePjReviewItem)                — คุมด้วย policy SECTION 2 ด้านบน → แก้แล้ว
--   3) upsert public.pj_applied_ledger (ledger กันลงซ้ำ)                  — mig 0080: ไม่ได้ enable RLS เลย ใช้ default grant จาก 0017
--                                                                            (service_role + authenticated เขียนได้อยู่แล้ว) → ไม่ต้องแก้
-- สรุป: ช่องโหว่จริงมีแค่ pj_sync_review/pj_sync_runs (แก้ใน migration นี้) — record_payment_spread และ
-- pj_applied_ledger ไม่มี admin-only guard ซ่อนอยู่ ไม่ต้องแก้เพิ่ม
--
-- ⚠️ หมายเหตุสำคัญ: หน้า PjSyncReview.tsx (src/pages) ปัจจุบัน gate ด้วย `isAdmin` ที่ frontend
-- (แสดง "เฉพาะแอดมินเท่านั้น" ให้ role อื่นเห็นทันที ก่อนจะยิง query ด้วยซ้ำ) — ต้องให้น้องวิวแก้ฝั่ง UI
-- เพิ่มด้วย ไม่งั้น staff จะเข้าหน้านี้ไม่ได้เลยแม้ RLS จะอนุญาตแล้ว (ครีมส่งต่อให้น้องวิว)

-- ============================================================================
-- SECTION 4: Smoke SQL (รันมือหลัง apply ผ่าน MCP)
-- ============================================================================
-- select tablename, policyname, cmd from pg_policies
--  where tablename in ('pj_sync_runs','pj_sync_review') order by tablename, policyname;
-- expected: policy 3 ตัว (ชื่อเดิม) — definition มี is_staff() เพิ่มเข้าไป (ดูด้วย pg_get_expr หรือ qual column)
