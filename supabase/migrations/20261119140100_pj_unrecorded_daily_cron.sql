-- 20261119140100: ตั้งเวลาตรวจใบ PJ ตกหล่นอัตโนมัติทุกวัน 03:07 (เวลาไทย) ย้อน 35 วัน — เขียนเข้ากล่องรอตรวจเท่านั้น ไม่ลงเงิน
-- ⚠️ apply หลังคุณเตยเห็นขนาด backfill (dry-run) แล้วเท่านั้น + ต้อง apply 20261119140000 และ deploy pj-sync (mode unrecorded_watch) ก่อน
--
-- ไม่ฝังกุญแจในไฟล์: ดึง URL + x-pj-sync-key จากคำสั่งของ cron jobid 6 (pj-sync-15min) ที่ใช้งานอยู่ตอน apply
-- (วิธีเดียวกับที่ครีมเรียก pj-sync เองด้วย substring) — กุญแจจึงเก็บใน cron.command เหมือน jobid 6/8 เดิม
-- fail-closed: อ่าน URL/กุญแจไม่ได้ -> raise ไม่สร้าง job
-- cron เวลา UTC: 20:07 UTC = 03:07 Asia/Bangkok (เลี่ยงนาทีของ jobid 6 ทุก 15 นาที: 0,15,30,45)
-- Idempotent: unschedule ชื่อเดิมก่อนสร้างใหม่ (ไม่แตะ jobid 6/8)

do $$
declare
  v_cmd text;
  v_url text;
  v_key text;
  v_body text := '{"mode":"unrecorded_watch","days_back":35,"dry_run":false,"batch":"daily"}';
begin
  select command into v_cmd from cron.job where jobid = 6;
  if v_cmd is null then
    raise exception 'ไม่พบ cron jobid 6 — ตั้ง job ใหม่ไม่ได้';
  end if;
  v_url := substring(v_cmd from 'https://[A-Za-z0-9.-]+/functions/v1/pj-sync');
  v_key := substring(v_cmd from 'x-pj-sync-key["'']?\s*[:,=]+\s*["'']([^"'']+)["'']');
  if v_url is null or v_key is null then
    raise exception 'อ่าน URL/กุญแจจาก jobid 6 ไม่ได้ (รูปแบบคำสั่งต่างจากที่คาด) — ดู command ของ jobid 6 แล้วสร้าง job มือ';
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'pj-unrecorded-daily';

  perform cron.schedule(
    'pj-unrecorded-daily',
    '7 20 * * *',
    format(
      'select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'', ''application/json'', ''x-pj-sync-key'', %L), body := %L::jsonb, timeout_milliseconds := 150000);',
      v_url, v_key, v_body
    )
  );
end
$$;

-- Verify: select jobid, jobname, schedule, active, left(command, 90) from cron.job where jobname = 'pj-unrecorded-daily';  -- 1 แถว active=true schedule '7 20 * * *'
-- ปิดชั่วคราว: select cron.unschedule('pj-unrecorded-daily');
