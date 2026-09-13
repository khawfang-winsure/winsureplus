-- 0156: แก้ source ให้ตรง prod จริง — media_email_max_total_mb เปลี่ยนจาก 12 → 16 MB
-- เหตุผล: 0154 seed ค่านี้ = '12' (on conflict do nothing) แต่คุณเตยเคาะเปลี่ยนเป็น 16 MB
-- (ล็อก 2026-09-13) หลังวัดจริงว่า Gmail SMTP รับ ~200 KB/s บนเน็ตที่ใช้ส่ง — ไฟล์แนบรวม 17 MiB
-- ใช้เวลาส่ง ≈128-136 วินาที ใกล้ wall-clock limit 150 วินาทีของ Edge Function (แผนฟรี) เกินไป จึง
-- ตั้งเพดานใช้งานจริงไว้ที่ 16 MB (ค่าสูงสุดที่ยังปลอดภัยคือ 17 — เผื่อ margin ให้ 16) ครีมรัน
-- `update` ตรงบน prod ไปแล้ว แต่ source ในไฟล์ migration (0154) ยัง apply ไปแล้วห้ามแก้ย้อนหลัง จึง
-- ต้องมีไฟล์ใหม่นี้เพื่อให้ environment ใหม่ในอนาคต (restore/staging) ได้ค่าตรงกับ prod จริง
--
-- Additive + idempotent: update เฉพาะแถวที่ยังเป็นค่าเดิม '12' (ไม่ทับถ้าคุณเตยตั้งเลขอื่นไปแล้วในอนาคต)
-- + insert on conflict do nothing กันกรณี key หายไปทั้งแถว (เช่น apply migration list ใหม่ตั้งแต่ต้นแล้ว
-- 0154 ยังไม่เคย apply มาก่อน) — ไม่แตะตาราง/คอลัมน์/ฟังก์ชันใดๆ นอกจากแถวเดียวใน app_settings

update public.app_settings
set value = '16'
where key = 'media_email_max_total_mb'
  and value = '12';

insert into public.app_settings (key, value, description) values
  ('media_email_max_total_mb', '16', 'ขนาดรวมไฟล์แนบสูงสุดต่อ 1 อีเมลบริษัท (รูป+คลิปรวมกัน) เป็น MB — ล็อก 16 MB (2026-09-13) จากการวัดจริงว่า Gmail SMTP ส่งได้ ~200 KB/s ทำให้ไฟล์รวมเกิน ~17 MiB เสี่ยงชน wall-clock limit 150 วินาทีของ Edge Function (แผนฟรี) — 17 คือเพดานทางเทคนิคสูงสุดที่ยังปลอดภัย ตั้งใช้งานจริงที่ 16 เผื่อ margin')
on conflict (key) do nothing;

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- select key, value, description from public.app_settings
--  where key = 'media_email_max_total_mb';
-- -- expected: value = '16'
