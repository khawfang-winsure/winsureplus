-- 0075_summary_two_stage.sql
-- เพิ่มสถานะ 2 ด่านของการส่งสรุปยอด: รอบ 1 = ส่งร้าน / รอบ 2 = ส่งบัญชี
-- additive + idempotent — รันซ้ำปลอดภัย
-- คอลัมน์ public.contracts ได้ grant จาก 0017 อยู่แล้ว (เพิ่มคอลัมน์ในตารางเดิมไม่ต้อง grant ใหม่)

alter table public.contracts add column if not exists summary_shop_sent_at timestamptz;
alter table public.contracts add column if not exists summary_shop_sent_by text;
alter table public.contracts add column if not exists summary_accounting_sent_at timestamptz;
alter table public.contracts add column if not exists summary_accounting_sent_by text;

-- Backfill (Pete เคาะ): เคสเก่าที่เคยส่งสรุปยอดแล้ว = ถือว่าจบทั้ง 2 ด่าน
-- (ไม่เด้งกลับมาในแท็บไหน)
update public.contracts
   set summary_shop_sent_at = summary_sent_at,
       summary_shop_sent_by = summary_sent_by,
       summary_accounting_sent_at = summary_sent_at,
       summary_accounting_sent_by = summary_sent_by
 where summary_sent_at is not null
   and summary_shop_sent_at is null;  -- idempotent กัน re-run ทับ
