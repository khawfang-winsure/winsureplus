-- 20261117100000: คืนเครื่อง/ขายเครื่อง เลือก "วันที่จริง" ได้ (created_at/priced_at/transferred_at/shipped_at = วันเกิดเหตุจริง) และเก็บเวลาคีย์จริงไว้ใน recorded_at / sold_recorded_at
-- additive เท่านั้น ไม่แตะ trigger/RLS (policy device_returns_staff ให้ staff/admin เขียนได้ทุกคอลัมน์อยู่แล้ว)

alter table public.device_returns
  add column if not exists recorded_at timestamptz not null default now();

-- backfill ครั้งเดียว: แถวเดิมใช้ created_at เป็นเวลาคีย์ (รันซ้ำไม่ทับ: ทำเฉพาะตอนยังไม่มีแถวไหนมี recorded_at ต่างจาก created_at)
do $$
begin
  if not exists (select 1 from public.device_returns where recorded_at <> created_at and recorded_at < now() - interval '1 minute') then
    update public.device_returns set recorded_at = created_at where recorded_at <> created_at;
  end if;
end $$;

alter table public.device_returns
  add column if not exists sold_recorded_at timestamptz;

comment on column public.device_returns.recorded_at is 'เวลาที่พนักงานคีย์การคืนเครื่องเข้าระบบจริง (created_at = วันคืนจริงที่ผู้ใช้เลือก)';
comment on column public.device_returns.sold_recorded_at is 'เวลาที่พนักงานคีย์ขั้นขาย/โอน/ส่งเข้าระบบจริง (transferred_at/shipped_at = วันขายจริง)';
