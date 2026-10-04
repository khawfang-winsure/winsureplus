-- 0168: view โน้ตติดตามล่าสุด 1 แถวต่อสัญญา (v_follow_up_latest) — ลดข้อมูลที่หน้ากล่องรับงานดึงลง
--       (เดิม getInboxCases ดึงประวัติ follow_ups ทุกแถวของ ~80 เคส แล้วเก็บแค่แถวล่าสุดฝั่งเว็บ)
--
-- security_invoker = on (บังคับ ตาม 0018/0020 pattern): view รันด้วยสิทธิ์ของผู้เรียก
--   → RLS follow_ups_read (0099) ยังใช้เหมือนเดิม: admin/staff เห็นทุกสัญญา,
--     freelancer เห็นเฉพาะสัญญาใน grade/assigned_to ของตัวเอง — ห้ามถอดออก
--
-- DISTINCT ON (contract_id) ... ORDER BY contract_id, created_at DESC, id DESC
--   = "โน้ตล่าสุดต่อสัญญา" เหมือนที่โค้ดเว็บเดิมเลือก (order created_at desc แล้วเอาแถวแรก)
--   เพิ่ม id DESC เป็น tie-break ให้ผลคงที่เมื่อ created_at ซ้ำ (เดิมไม่การันตี)
-- คอลัมน์เท่าที่ Step 5 ของ getInboxCases ใช้: contract_id, note_text, created_at, author_name
-- additive: ไม่แก้ตาราง ไม่ลบอะไร

create or replace view public.v_follow_up_latest
  with (security_invoker = on) as
select distinct on (f.contract_id)
  f.contract_id,
  f.note_text,
  f.created_at,
  f.author_name
from public.follow_ups f
order by f.contract_id, f.created_at desc, f.id desc;

grant select on public.v_follow_up_latest to authenticated;
grant select on public.v_follow_up_latest to service_role;

comment on view public.v_follow_up_latest is
  '(0168) โน้ตติดตามล่าสุด 1 แถวต่อสัญญา (DISTINCT ON contract_id, created_at desc, id desc) สำหรับกล่องรับงาน;
   security_invoker=on ให้ RLS follow_ups_read apply ตาม caller (freelancer scope grade/assigned_to) — ห้ามถอดออก';

-- ============================================================================
-- Verify checklist สำหรับครีม (รันหลัง apply)
-- ============================================================================
-- 0) security_invoker ติดจริง:
-- SELECT relname, reloptions FROM pg_class WHERE relname = 'v_follow_up_latest';   -- {security_invoker=on}
-- 1) grant:
-- SELECT has_table_privilege('authenticated','public.v_follow_up_latest','SELECT'),
--        has_table_privilege('service_role','public.v_follow_up_latest','SELECT');  -- true,true
-- 2) ผลตรงกับ "แถวล่าสุดต่อสัญญา" ของ follow_ups ทุกสัญญา (ต้อง 0 แถวทั้งสองทิศ):
-- (select f.contract_id, f.note_text, f.created_at, f.author_name from public.v_follow_up_latest f
--  except
--  select distinct on (contract_id) contract_id, note_text, created_at, author_name from public.follow_ups
--   order by contract_id, created_at desc, id desc)
-- ;
-- 3) จำนวนแถว = จำนวนสัญญาที่เคยมี follow_up:
-- SELECT (SELECT count(*) FROM public.v_follow_up_latest) AS v, (SELECT count(DISTINCT contract_id) FROM public.follow_ups) AS d;
