-- ตั้งเวลาปิดคำขอลงพื้นที่อัตโนมัติ (ลูกค้าชำระครบก่อนเข้ารอบ) ทุก 15 นาที — apply หลังคุณเตยเห็น dry-run แล้วเท่านั้น
-- ต้องมี migration 20261118090000 ก่อน (ฟังก์ชัน auto_close_paid_field_visit_requests)

select cron.unschedule('fv-auto-close')
where exists (select 1 from cron.job where jobname = 'fv-auto-close');

select cron.schedule(
  'fv-auto-close',
  '7,22,37,52 * * * *',
  $$ select public.auto_close_paid_field_visit_requests(); $$
);

-- Verify: select jobid, jobname, schedule, active from cron.job where jobname = 'fv-auto-close';  -- 1 แถว active=true
