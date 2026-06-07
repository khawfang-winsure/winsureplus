-- ============================================================================
-- Phase 4 — งานอัตโนมัติรายวัน: คำนวณวันล่าช้า + ค่าปรับ + แจ้งเตือน
-- ก๊อปไปวางใน SQL Editor หลังรัน 0002
-- ============================================================================

-- ฟังก์ชันหลัก: รันทุกวันเพื่ออัปเดตงวดที่ค้าง (ห้าม auto-mark ว่าจ่าย!)
create or replace function run_daily_update()
returns void language plpgsql security definer set search_path = public as $$
declare
  per_day numeric := (select value::numeric from app_settings where key = 'penalty_per_day');
  max_days int := (select value::int from app_settings where key = 'penalty_max_days');
begin
  -- 1) งวดที่ยังไม่จ่ายและเลยกำหนด -> สถานะ late + ค่าปรับ (100/วัน เพดาน 7 วัน = เดือนแรกของการล่าช้าแต่ละงวด)
  update installments i
  set status = 'late',
      penalty_days = least(current_date - i.due_date, max_days),
      penalty_amount = least(current_date - i.due_date, max_days) * per_day
  from contracts c
  where i.contract_id = c.id
    and c.status = 'active'
    and i.paid_at is null
    and i.due_date < current_date;

  -- 2) แจ้งเตือน: ครบกำหนดชำระวันนี้ (กันซ้ำในวันเดียว)
  insert into notifications (contract_id, type, message)
  select i.contract_id, 'due_today', 'ครบกำหนดชำระวันนี้'
  from installments i
  join contracts c on c.id = i.contract_id
  where c.status = 'active' and i.paid_at is null and i.due_date = current_date
    and not exists (
      select 1 from notifications n
      where n.contract_id = i.contract_id and n.type = 'due_today'
        and n.created_at::date = current_date
    );

  -- 3) แจ้งเตือน: เพิ่งเลยกำหนด (เลยมา 1 วัน)
  insert into notifications (contract_id, type, message)
  select i.contract_id, 'newly_late', 'เลยกำหนดชำระแล้ว'
  from installments i
  join contracts c on c.id = i.contract_id
  where c.status = 'active' and i.paid_at is null and i.due_date = current_date - 1
    and not exists (
      select 1 from notifications n
      where n.contract_id = i.contract_id and n.type = 'newly_late'
        and n.created_at::date = current_date
    );
end;
$$;

-- ============================================================================
-- ตั้งเวลาให้รันอัตโนมัติทุกวัน (ต้องเปิด extension pg_cron ก่อน)
-- เวลา cron เป็น UTC: '5 0 * * *' = 00:05 UTC = 07:05 น. เวลาไทย
-- ============================================================================
create extension if not exists pg_cron;

-- ลบตารางเวลาเดิมถ้ามี แล้วตั้งใหม่ (กันซ้ำตอนรันหลายครั้ง)
select cron.unschedule('winsure-daily')
where exists (select 1 from cron.job where jobname = 'winsure-daily');

select cron.schedule('winsure-daily', '5 0 * * *', $$ select run_daily_update(); $$);

-- 💡 อยากทดสอบทันทีโดยไม่รอ: รัน  select run_daily_update();  ใน SQL Editor
