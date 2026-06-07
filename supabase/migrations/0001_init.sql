-- ============================================================================
-- WIN SURE PLUS — โครงฐานข้อมูลเริ่มต้น (Phase 1/3/4/6 foundation)
-- วิธีใช้: ก๊อปไฟล์นี้ทั้งหมด ไปวางใน Supabase Dashboard > SQL Editor > Run
-- (Postgres 17) — รันได้ครั้งเดียว ถ้ารันซ้ำให้ลบตารางเดิมก่อน
-- ============================================================================

-- ========== 1) ตารางผู้ใช้ + บทบาท (admin / staff) ==========
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

-- ฟังก์ชันเช็คว่าเป็นแอดมินไหม (ใช้ในกฎสิทธิ์ RLS)
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- สร้าง profile อัตโนมัติเมื่อมีผู้ใช้ใหม่สมัคร
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ========== 2) ค่าคงที่ที่ปรับได้ (ไม่ hardcode) ==========
create table if not exists app_settings (
  key text primary key,
  value text not null,
  description text
);

insert into app_settings (key, value, description) values
  ('doc_fee', '100', 'ค่าเอกสาร (หักออกจากยอดโอน) — อนาคตอาจเปลี่ยน'),
  ('penalty_per_day', '100', 'ค่าปรับล่าช้าต่อวัน (บาท)'),
  ('penalty_max_days', '7', 'จำนวนวันสูงสุดที่คิดค่าปรับต่อ 1 งวด')
on conflict (key) do nothing;

-- ========== 3) ร้านค้า ==========
create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  code text not null,                 -- เช่น "AQ S00016"
  name text not null,
  bank text,
  account_no text,
  account_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ========== 4) ตัวเลือกที่ตั้งค่าได้ (ลบ = active=false ข้อมูลเก่าไม่หาย) ==========
-- รวมทุกชนิดไว้ตารางเดียว แยกด้วยคอลัมน์ kind เพื่อให้จัดการง่าย
create table if not exists options (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'phone_model', 'storage', 'occupation', 'occupation_proof', 'promotion'
  )),
  label text not null,
  detail text,                        -- ใช้กับโปรโมชั่น (รายละเอียดโปร)
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists options_kind_idx on options (kind, active);

-- ========== 5) สัญญา (1 แถว = 1 สัญญา/ลูกค้า) ==========
create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  -- เลขอ้างอิง
  contract_no text not null,
  inv_no text,
  sn text,
  -- ลูกค้า
  customer_name text not null,
  phone text,
  phone_alt1 text,
  phone_alt2 text,
  facebook_link text,
  birth_year int,                     -- เก็บปีเกิด แล้วคำนวณช่วงอายุภายหลัง
  occupation text,
  occupation_proof text,
  -- เครื่อง
  shop_id uuid references shops (id),
  model text,
  storage text,
  condition text check (condition in ('new', 'used')),      -- มือ1/มือ2
  origin text check (origin in ('th', 'inter')),            -- เครื่องไทย/เครื่องนอก
  device_price numeric not null default 0,
  -- การเงินซื้อเครื่อง (สำหรับสรุปยอดโอน)
  down_percent numeric not null default 0,
  commission_percent numeric not null default 0,
  doc_fee numeric not null default 100,
  -- ยอดที่คำนวณอัตโนมัติ (generated) — ใช้รายงาน/รวมยอดได้เลย ไม่ต้องคำนวณซ้ำ
  after_down numeric generated always as (
    round(device_price * (1 - down_percent / 100.0))
  ) stored,
  commission_amount numeric generated always as (
    round(round(device_price * (1 - down_percent / 100.0)) * commission_percent / 100.0)
  ) stored,
  net_transfer numeric generated always as (
    round(device_price * (1 - down_percent / 100.0))
    + round(round(device_price * (1 - down_percent / 100.0)) * commission_percent / 100.0)
    - doc_fee
  ) stored,
  -- การเงินผ่อน
  finance_amount numeric default 0,
  monthly_payment numeric default 0,
  term_months int default 0,
  due_day int check (due_day between 1 and 31),
  -- โปรโมชั่น
  has_promotion boolean not null default false,
  promotion text,
  promotion_detail text,
  -- lifecycle
  status text not null default 'active'
    check (status in ('active', 'closed', 'returned', 'returned_closed', 'online')),
  transaction_date date not null default current_date,       -- รองรับย้อนหลัง
  operator text,
  notes text,
  -- flag กันส่งซ้ำ
  summary_sent_at timestamptz,
  email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contracts_shop_idx on contracts (shop_id);
create index if not exists contracts_status_idx on contracts (status);
create index if not exists contracts_txn_date_idx on contracts (transaction_date);

-- ========== 6) งวดผ่อน (สร้างอัตโนมัติตามจำนวนเดือน) ==========
create table if not exists installments (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts (id) on delete cascade,
  installment_no int not null,
  due_date date not null,
  amount numeric not null default 0,
  paid_at timestamptz,                -- null = ยังไม่ชำระ (ยืนยันโดยพนักงานเท่านั้น)
  penalty_days int not null default 0,
  penalty_amount numeric not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'late')),
  unique (contract_id, installment_no)
);
create index if not exists installments_contract_idx on installments (contract_id);
create index if not exists installments_due_idx on installments (due_date) where paid_at is null;

-- ========== 7) การคืนเครื่อง (3 กรณี) ==========
create table if not exists device_returns (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts (id) on delete cascade,
  case_no int not null check (case_no in (1, 2, 3)),
  last_installment_paid boolean not null default false,
  penalty_paid boolean not null default false,
  repair_fee numeric default 0,       -- ใส่เพิ่มได้ภายหลังหลังเช็คเครื่อง
  checked_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

-- ========== 8) แจ้งเตือน (สร้างโดยงานอัตโนมัติรายวัน) ==========
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid references contracts (id) on delete cascade,
  type text not null check (type in ('due_today', 'newly_late')),
  message text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

-- ============================================================================
-- ฟังก์ชันกฎธุรกิจ
-- ============================================================================

-- วันครบกำหนด clamp ปลายเดือน (เช่น due_day=31 เดือนมี 30 วัน -> วันที่ 30)
create or replace function due_date_for(p_year int, p_month int, p_due_day int)
returns date language sql immutable as $$
  select make_date(
    p_year, p_month,
    least(
      p_due_day,
      extract(day from (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day'))::int
    )
  );
$$;

-- ค่าปรับของงวดที่ค้าง 1 งวด: 100/วัน สูงสุด 7 วัน (เพดาน 700) — อ่านค่าจาก app_settings
create or replace function penalty_for(p_days_late int)
returns numeric language sql stable as $$
  select case
    when p_days_late <= 0 then 0
    else least(
           p_days_late,
           (select value::int from app_settings where key = 'penalty_max_days')
         ) * (select value::numeric from app_settings where key = 'penalty_per_day')
  end;
$$;

-- ============================================================================
-- Views (จุดที่ Postgres เหนือกว่า: คำนวณกลุ่มล่าช้า + รวมยอด เป็น query เดียว)
-- ============================================================================

-- สถานะ + จำนวนวันล่าช้า + กลุ่ม (คำนวณจากงวดค้างที่เก่าสุด)
create or replace view v_contract_status as
with nd as (
  select c.id as contract_id,
         (select min(i.due_date) from installments i
           where i.contract_id = c.id and i.paid_at is null) as next_due
  from contracts c
)
select
  c.id as contract_id,
  c.customer_name,
  c.shop_id,
  c.status,
  nd.next_due,
  case
    when c.status <> 'active' or nd.next_due is null then 0
    else greatest(0, (current_date - nd.next_due))
  end as days_late,
  case
    when c.status <> 'active' or nd.next_due is null or current_date <= nd.next_due then 'normal'
    when current_date - nd.next_due <= 10 then '1-10'
    when current_date - nd.next_due <= 30 then '11-30'
    when current_date - nd.next_due <= 60 then '31-60'
    when current_date - nd.next_due <= 90 then '61-90'
    when current_date - nd.next_due <= 120 then '91-120'
    else '120+'
  end as bucket
from contracts c
join nd on nd.contract_id = c.id;

-- รวมยอดโอนต่อร้านต่อวัน (สำหรับหน้าสรุปยอด / วัดผลร้านค้า)
create or replace view v_daily_transfer_summary as
select
  c.transaction_date,
  c.shop_id,
  s.name as shop_name,
  count(*) as items,
  sum(c.net_transfer) as total_net
from contracts c
join shops s on s.id = c.shop_id
group by c.transaction_date, c.shop_id, s.name;

-- ============================================================================
-- Row Level Security (admin แก้ตั้งค่าได้, staff จัดการสัญญาได้, ทุกคนอ่านได้)
-- ============================================================================
alter table profiles enable row level security;
alter table app_settings enable row level security;
alter table shops enable row level security;
alter table options enable row level security;
alter table contracts enable row level security;
alter table installments enable row level security;
alter table device_returns enable row level security;
alter table notifications enable row level security;

-- profiles: อ่านของตัวเองได้, แอดมินอ่านได้หมด
create policy profiles_read on profiles for select to authenticated
  using (id = auth.uid() or is_admin());
create policy profiles_admin_write on profiles for all to authenticated
  using (is_admin()) with check (is_admin());

-- ตารางตั้งค่า (settings/shops/options): ทุกคนที่ล็อกอินอ่านได้, เฉพาะแอดมินแก้
do $$
declare t text;
begin
  foreach t in array array['app_settings', 'shops', 'options'] loop
    execute format('create policy %1$s_read on %1$s for select to authenticated using (true);', t);
    execute format('create policy %1$s_admin_write on %1$s for all to authenticated using (is_admin()) with check (is_admin());', t);
  end loop;
end $$;

-- ตารางงาน (contracts/installments/returns/notifications): พนักงาน+แอดมินจัดการได้
do $$
declare t text;
begin
  foreach t in array array['contracts', 'installments', 'device_returns', 'notifications'] loop
    execute format('create policy %1$s_all on %1$s for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;
