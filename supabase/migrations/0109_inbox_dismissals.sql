-- 0109: กล่องรับงาน — เคลียร์เคสออก (dismiss) แบบกลับมาได้เมื่อมีความเคลื่อนไหวใหม่
--
-- ปัญหา Pete: เคส "นัดแล้วไม่จ่าย" (promise ค้าง) กองใน /inbox โชว์ "เลยนัด X วัน" เรื่อยๆ
--   ไม่มีปุ่มเอาออก. ต้องเพิ่มปุ่มเคลียร์ แต่กันลืม → เคสกลับมาถ้ามีความเคลื่อนไหวใหม่
--   หลังเวลาที่เคลียร์ (โน้ตใหม่ / คืนเครื่องใหม่ / re-pin)
--
-- โครง mirror inbox_pins (0047 SECTION 3): เครื่องมือ admin + staff เท่านั้น
-- upsert ได้ (re-dismiss = อัปเดต dismissed_at) — trigger บังคับ dismissed_at := now()
--   ทั้ง INSERT + UPDATE path (เหมือน touch_queue_case_seen 0047 — default now() ไม่ fire ตอน UPDATE)

-- ============================================================================
-- SECTION 1: ตาราง inbox_dismissals
-- ============================================================================
create table if not exists public.inbox_dismissals (
  contract_id       uuid primary key references public.contracts(id) on delete cascade,
  dismissed_at      timestamptz not null default now(),
  dismissed_by_id   uuid,                 -- snapshot คนกดเคลียร์ (ไม่ FK — กันลบ profile แล้วประวัติหาย)
  dismissed_by_name text,                 -- snapshot ชื่อ ณ เวลาเคลียร์
  note              text                  -- เหตุผล (nullable)
);

alter table public.inbox_dismissals enable row level security;

-- ============================================================================
-- SECTION 2: Trigger — บังคับ dismissed_at := now() ทุก INSERT + UPDATE
-- ============================================================================
-- เหตุผล (เหมือน touch_queue_case_seen 0047):
--   `default now()` fire เฉพาะ INSERT ใหม่. upsert ที่ชนกุญแจ (on conflict do update)
--   เข้า UPDATE path → default ไม่ fire → dismissed_at ค้างค่าเดิม → re-dismiss ไม่ refresh
--   → เคสที่เคยเคลียร์แล้วโดนกิจกรรมเก่าดันกลับมาผิด
-- Fix: BEFORE INSERT OR UPDATE บังคับ now() เสมอ (server-side — กัน client clock skew ด้วย)
--   ผลพลอยได้: dismissed_at ของ dismiss > created_at ของ follow_up ที่วิวเพิ่งบันทึกก่อนหน้า
--   (เคลียร์พร้อมบันทึกคุย) → ไม่ re-appear ทันที
create or replace function public.touch_inbox_dismissal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.dismissed_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_inbox_dismissal on public.inbox_dismissals;
create trigger trg_touch_inbox_dismissal
  before insert or update on public.inbox_dismissals
  for each row execute function public.touch_inbox_dismissal();

-- ============================================================================
-- SECTION 3: RLS policies — mirror inbox_pins (admin + staff เท่านั้น; freelancer เข้าไม่ได้)
-- ============================================================================
-- SELECT
drop policy if exists id_select on public.inbox_dismissals;
create policy id_select on public.inbox_dismissals
  for select to authenticated
  using (is_admin() OR is_staff());

-- INSERT
drop policy if exists id_insert on public.inbox_dismissals;
create policy id_insert on public.inbox_dismissals
  for insert to authenticated
  with check (is_admin() OR is_staff());

-- UPDATE (รองรับ upsert on conflict do update = re-dismiss)
drop policy if exists id_update on public.inbox_dismissals;
create policy id_update on public.inbox_dismissals
  for update to authenticated
  using    (is_admin() OR is_staff())
  with check (is_admin() OR is_staff());

-- DELETE (เผื่ออนาคต — ยกเลิกการเคลียร์แบบถาวร)
drop policy if exists id_delete on public.inbox_dismissals;
create policy id_delete on public.inbox_dismissals
  for delete to authenticated
  using (is_admin() OR is_staff());

-- ============================================================================
-- SECTION 4: GRANTs (explicit belt-and-suspenders — เหมือน inbox_pins 0047)
-- ============================================================================
-- service_role: 0017 default privileges ครอบอยู่แล้ว → explicit เพื่อ audit trail
grant select, insert, update, delete on public.inbox_dismissals to service_role;
-- authenticated: explicit ครอบ 4 operations ที่ policies อนุญาต
grant select, insert, update, delete on public.inbox_dismissals to authenticated;

-- ============================================================================
-- SECTION 5: Verify checklist สำหรับครีม (รันหลัง apply — not executed here)
-- ============================================================================
-- 5a) ตารางมีจริง + คอลัมน์ครบ:
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'inbox_dismissals'
--  ORDER BY ordinal_position;
-- expected: contract_id(uuid,NO) dismissed_at(timestamptz,NO) dismissed_by_id(uuid,YES)
--           dismissed_by_name(text,YES) note(text,YES)

-- 5b) RLS เปิด + 4 policies:
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.inbox_dismissals'::regclass; -- true
-- SELECT polname FROM pg_policy WHERE polrelid = 'public.inbox_dismissals'::regclass ORDER BY polname;
-- expected: id_delete / id_insert / id_select / id_update

-- 5c) GRANTs:
-- SELECT has_table_privilege('service_role',  'public.inbox_dismissals', 'SELECT'); -- true
-- SELECT has_table_privilege('service_role',  'public.inbox_dismissals', 'DELETE'); -- true
-- SELECT has_table_privilege('authenticated', 'public.inbox_dismissals', 'INSERT'); -- true
-- SELECT has_table_privilege('authenticated', 'public.inbox_dismissals', 'UPDATE'); -- true

-- 5d) Trigger บังคับ now() ทุก upsert:
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.inbox_dismissals'::regclass AND NOT tgisinternal;
-- expected: trg_touch_inbox_dismissal
