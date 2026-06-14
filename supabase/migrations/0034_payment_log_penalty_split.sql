-- 0034: เพิ่ม penalty_paid_amount ใน payment_log สำหรับแยกยอดค่าปรับออกจากค่างวด

alter table public.payment_log
  add column if not exists penalty_paid_amount numeric(12,2) default 0;
