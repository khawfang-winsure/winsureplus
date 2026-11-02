-- 0176: ตั้งวันเริ่มบังคับคลิปรอบตัวเครื่อง = 2026-11-02
-- apply ผ่าน MCP บน prod แล้วเมื่อ 2026-11-02 ตามที่เจ้าของ (คุณเตย) เคาะ — ไฟล์นี้บันทึกให้ตรงกับที่รันจริง
update app_settings set value = '2026-11-02' where key = 'media_around_video_required_from';
