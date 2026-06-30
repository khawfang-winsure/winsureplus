-- 0080: สร้างสมุดบัญชีกันลงซ้ำ pj_applied_ledger (idempotency ledger สำหรับ PJ Auto-Sync)
-- หมายเหตุ: ตารางอยู่ใน public.* ได้ default privileges จาก migration 0017 (service_role + authenticated) โดยอัตโนมัติ
-- service_role ใช้เขียนผ่าน Edge Function (pj-sync) และ authenticated ใช้ผ่าน db.ts (applyPjReviewPayment)

create table if not exists public.pj_applied_ledger (
  id          uuid        primary key default gen_random_uuid(),
  contract_id uuid        not null references public.contracts(id) on delete cascade,
  pj_paid_date date       not null,
  inst_amount  numeric    not null default 0,  -- เงินต้นค่างวดรวมของวันนั้น
  pen_amount   numeric    not null default 0,  -- ค่าปรับรวมของวันนั้น
  source       text       not null default 'auto',  -- 'auto' (cron ลงเอง) | 'review' (พนักงานกดยืนยัน)
  applied_at   timestamptz not null default now(),
  unique (contract_id, pj_paid_date)
  -- unique constraint สร้าง B-tree index บน (contract_id, pj_paid_date) ให้อัตโนมัติ ไม่ต้องสร้างเพิ่ม
);
