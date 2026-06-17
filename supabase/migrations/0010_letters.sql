-- ============================================================================
-- 0010 — ฟังก์ชันส่งจดหมายติดตามหนี้ (ที่อยู่ลูกค้า + บันทึกการส่งจดหมาย)
-- ก๊อปไปวางใน SQL Editor ของ Supabase แล้วกด Run (รันได้แม้รัน 0001–0009 ไปแล้ว)
--
-- ปลอดภัย: เป็นการ "เพิ่มตารางใหม่ 2 ตาราง" ล้วนๆ ไม่แตะตารางเดิม ไม่ต้องรื้ออะไร
-- ============================================================================

-- ---------- 1) ที่อยู่ลูกค้า (แยกช่อง · หลายชุดต่อสัญญา) ----------
-- kind: current=ปัจจุบัน, id_card=ตามบัตร, work=ที่ทำงาน, registry=ทะเบียนราษฎร์
create table if not exists customer_addresses (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts (id) on delete cascade,
  kind text not null check (kind in ('current', 'id_card', 'work', 'registry')),
  house_no text,      -- บ้านเลขที่
  moo text,           -- หมู่
  soi text,           -- ซอย
  road text,          -- ถนน
  subdistrict text,   -- ตำบล/แขวง
  district text,      -- อำเภอ/เขต
  province text,      -- จังหวัด
  postal_code text,   -- รหัสไปรษณีย์
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, kind)
);
create index if not exists customer_addresses_contract_idx on customer_addresses (contract_id);

-- ---------- 2) บันทึกการส่งจดหมาย ----------
-- episode_key = วันครบกำหนดของงวดที่ค้าง (next_due) ที่ทำให้รอบนี้เริ่ม
--   → จ่ายเงินแล้วงวดค้างเปลี่ยน = รอบใหม่ (round เริ่ม 1 ใหม่) อัตโนมัติ
-- address_kind + recipient_snapshot = ที่อยู่ที่ "ปริ้นจริง" (snapshot ตอนปริ้น ไม่คิดใหม่)
create table if not exists collection_letters (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts (id) on delete cascade,
  episode_key date not null,
  round int not null check (round between 1 and 3),
  address_kind text not null check (address_kind in ('current', 'id_card', 'registry')),
  recipient_snapshot text,                 -- ที่อยู่ที่ปริ้น (ข้อความเต็ม ณ ตอนปริ้น)
  printed_at timestamptz not null default now(),
  tracking_no text,                        -- เลขพัสดุ (ยืนยันว่าส่งจริง)
  reply text not null default 'pending'
    check (reply in ('pending', 'replied', 'no_reply')),  -- รอ/ตอบกลับ/ไม่ตอบ
  created_at timestamptz not null default now(),
  unique (contract_id, episode_key, round)
);
create index if not exists collection_letters_contract_idx on collection_letters (contract_id, episode_key);

-- ---------- 3) ข้อความจดหมายตัวอย่าง (แก้ไขได้ในแอป) ----------
-- ใช้ตัวแปร {{name}} {{address}} {{contractNo}} {{amount}} {{daysLate}} {{date}}
insert into app_settings (key, value, description) values (
  'letter_template',
  E'เรียน คุณ{{name}}\n\nตามที่ท่านได้ทำสัญญาเช่าซื้อเลขที่ {{contractNo}} ปัจจุบันท่านค้างชำระค่างวดเป็นเวลา {{daysLate}} วัน รวมเป็นเงิน {{amount}} บาท\n\nบริษัทขอให้ท่านติดต่อชำระภายใน 7 วันนับจากวันที่ได้รับจดหมายฉบับนี้ หากท่านได้ชำระแล้วขออภัยมา ณ ที่นี้\n\nจึงเรียนมาเพื่อโปรดดำเนินการ\n\nขอแสดงความนับถือ\nWIN SURE PLUS',
  'ข้อความจดหมายติดตามหนี้ (แก้ในแอป) — ใช้ {{name}} {{address}} {{contractNo}} {{amount}} {{daysLate}} {{date}}'
) on conflict (key) do nothing;

-- ---------- 4) สิทธิ์ (RLS) — พนักงาน+แอดมินจัดการได้ (เหมือนตารางงานอื่น) ----------
alter table customer_addresses enable row level security;
alter table collection_letters enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'customer_addresses' and policyname = 'customer_addresses_all') then
    create policy customer_addresses_all on customer_addresses for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'collection_letters' and policyname = 'collection_letters_all') then
    create policy collection_letters_all on collection_letters for all to authenticated using (true) with check (true);
  end if;
end $$;

-- เผื่อ default privileges ยังไม่ครอบ — ให้สิทธิ์ตารางใหม่ตรงๆ
grant select, insert, update, delete on customer_addresses, collection_letters to authenticated;
