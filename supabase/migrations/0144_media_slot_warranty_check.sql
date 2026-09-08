-- 0144: เพิ่มช่องแนบรูป "รูปเช็คประกันตัวเครื่อง" (warranty_check) — เฉพาะสินค้ามือหนึ่ง
-- ที่มา: คำขอคุณเตย (2026-09-08) — ต้องเช็คประกันจากเลขเครื่องแล้วแคปหน้าผลตรวจ เก็บเป็นหลักฐานคู่สัญญา
-- pattern conditional เหมือน box_back เดิม (required เมื่อ condition = 'new') วางถัดจาก box_back
-- (sortOrder 4.1) ให้ 2 ช่องที่บังคับเฉพาะมือหนึ่งอยู่ติดกัน — ไม่แตะ/จัดฟอร์แมตอีก 14 ช่องเดิม
-- Idempotent: append เฉพาะกรณียังไม่มี key='warranty_check' ในอาเรย์ (กันรันซ้ำพัง/ซ้ำช่อง)

do $$
declare
  v_slots    jsonb;
  v_new_slot jsonb := '{
    "key": "warranty_check",
    "label": "รูปเช็คประกันตัวเครื่อง",
    "sortOrder": 4.1,
    "min": 1,
    "max": 1,
    "required": { "when": "condition", "equals": "new" },
    "hint": "เช็คประกันจากเลขเครื่อง แล้วแคปหน้าผลตรวจ"
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
    where e ->> 'key' = 'warranty_check'
  ) then
    raise notice 'warranty_check มีอยู่แล้วใน media_slots — ข้าม (idempotent)';
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
-- Verify (รันมือหลัง apply)
-- ============================================================================
-- 1) จำนวนช่องหลังเพิ่ม — ฐานปัจจุบันมี 15 ช่องอยู่แล้ว (รวม credit_history_evidence sortOrder 13.1
--    จาก 0137) ดังนั้นหลัง 0144 ควรเป็น 16 ไม่ใช่ 15 — เช็คจำนวนจริงก่อนพลาด assumption:
-- SELECT jsonb_array_length(value::jsonb) FROM app_settings WHERE key = 'media_slots';
--
-- 2) ช่องใหม่อยู่ครบ + required object ไม่หลุด:
-- SELECT elem
-- FROM app_settings, jsonb_array_elements(value::jsonb) elem
-- WHERE key = 'media_slots' AND elem ->> 'key' = 'warranty_check';
-- -- คาดว่า required = {"when": "condition", "equals": "new"}, sortOrder = 4.1, min=1, max=1
--
-- 3) รับรองว่าไม่ได้ไปแก้ค่าของ 14 ช่องเดิม (เทียบ label เดิมสุ่ม 2 ช่อง):
-- SELECT elem ->> 'label'
-- FROM app_settings, jsonb_array_elements(value::jsonb) elem
-- WHERE key = 'media_slots' AND elem ->> 'key' IN ('box_back', 'credit_history_evidence');
