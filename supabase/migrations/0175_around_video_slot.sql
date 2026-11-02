-- 0175: เพิ่มช่องแนบ "คลิปรอบตัวเครื่อง" (device_around_video) เข้า app_settings.media_slots — ไฟล์นี้ต้อง apply ทันทีก่อน push โค้ดใหม่เท่านั้น
-- ────────────────────────────────────────────────────────────────────────────
-- ทำไมแยกจาก 0174 ตั้งใจ: แท็บเว็บเก่าที่เปิดค้างอ่าน media_slots แล้วใช้ media_gate_from (2026-09-10) เป็นวันเริ่มของ "ทุกช่อง"
-- ถ้าเพิ่มช่องนี้ก่อนโค้ดใหม่ (ที่คุมวันเริ่มแยกด้วย media_around_video_required_from) ขึ้น ช่องใหม่จะโผล่ในทุกเคสตั้งแต่ 09-10
-- ลำดับ release (ต้องทำตามนี้ ไม่สลับ):
--   1) apply 0174  2) deploy Edge Function ทั้ง 3 ตัว (send-company-email, media-sign, media-purge) แล้วเทียบกับไฟล์ใน repo
--   3) push เว็บ รอ Vercel READY  4) apply 0175  5) hard-reload + smoke test
--   6) เจ้าของตั้ง media_around_video_required_from เป็นวันถัดไป (รูปแบบ YYYY-MM-DD)
--
-- ต้องมี 0174 แล้ว (flag around_video_required ใน media_gate_complete + setting) — ถ้ายังไม่มี ไฟล์นี้ยังไม่ทำให้อะไรพังเพราะ flag ที่ไม่รู้จัก = false
-- แต่ลำดับที่ถูกคือ 0174 ก่อนเสมอ
--
-- ช่อง: key device_around_video / label คลิปรอบตัวเครื่อง / sortOrder 15.1 / min 1 max 1 / kind video /
--       required = flag around_video_required (คำนวณใน media_gate_complete 0174 ไม่ใช่คอลัมน์ contracts)
-- pattern append idempotent จาก 0154 SECTION 3 (ข้ามถ้ามี key อยู่แล้ว; เรียงตาม sortOrder: 15 lock_test_video, 15.1 อันนี้, 16 ถัดไป)
--
-- Additive + idempotent. ไม่แตะ/ลบข้อมูลเดิม ไม่แตะ public.contracts

do $$
declare
  v_slots    jsonb;
  v_new_slot jsonb := '{
    "key": "device_around_video",
    "label": "คลิปรอบตัวเครื่อง",
    "hint": "2 คลิปรวมกันไม่เกิน 10.5 MB",
    "min": 1,
    "max": 1,
    "kind": "video",
    "required": { "when": "flag", "name": "around_video_required" },
    "sortOrder": 15.1
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
    where e ->> 'key' = 'device_around_video'
  ) then
    raise notice 'device_around_video มีอยู่แล้วใน media_slots — ข้าม (idempotent)';
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
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) media_slots มี 18 ช่อง (17 เดิม + device_around_video) และเรียง 15 -> 15.1 -> 16:
-- select jsonb_array_length(value::jsonb) from app_settings where key = 'media_slots'; -- expected 18
-- select elem ->> 'key', elem ->> 'sortOrder' from app_settings, jsonb_array_elements(value::jsonb) elem
--  where key = 'media_slots' and (elem ->> 'sortOrder')::numeric between 14 and 17 order by (elem ->> 'sortOrder')::numeric;

-- b) ช่องใหม่ถูกต้อง:
-- select elem from app_settings, jsonb_array_elements(value::jsonb) elem
--  where key = 'media_slots' and elem ->> 'key' = 'device_around_video';

-- c) setting ยังปิดอยู่ (ห้ามเปิดในไฟล์นี้ — คุณเตยสั่งเปิดแยก):
-- select value from app_settings where key = 'media_around_video_required_from'; -- expected 2099-12-31

-- d) apply ซ้ำต้องไม่เปลี่ยนอะไร (notice 'มีอยู่แล้ว') และจำนวนช่องยัง 18

-- e) regression: เกทของสัญญาทุกใบเท่าก่อน apply (setting ปิดอยู่ ช่องใหม่ไม่ถูกบังคับ):
-- select id, public.media_gate_complete(id) from public.contracts order by id; -- เทียบกับผลก่อน apply แถวต่อแถว

-- f) rollback test ของ idempotency + ลำดับ:
-- begin;
-- do $test$
-- declare v_before text; v_n int;
-- begin
--   select value into v_before from app_settings where key = 'media_slots';
--   select jsonb_array_length(v_before::jsonb) into v_n;
--   if v_n <> 18 then raise exception 'FAIL: media_slots ควรมี 18 ช่อง แต่เจอ %', v_n; end if;
--   if (select count(*) from jsonb_array_elements(v_before::jsonb) e where e->>'key' = 'device_around_video') <> 1 then
--     raise exception 'FAIL: device_around_video ต้องมี 1 ช่องพอดี';
--   end if;
--   raise notice 'PASS: media_slots ถูกต้อง';
-- end $test$;
-- rollback;
