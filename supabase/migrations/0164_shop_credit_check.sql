-- 0164: ระบบร้านค้าเช็คเครดิตลูกค้าเอง (Wave 1 — schema เท่านั้น ยังไม่มี Edge Function/หน้าเว็บ)
--
-- บริบท: ร้านพาร์ทเนอร์ (ยังไม่มี login วันนี้) จะส่งคำขอเช็คเครดิตผ่านฟอร์มสาธารณะ (Vite entry แยก)
--   ทาง anon เข้าถึงทุกอย่างผ่าน Edge Function `credit-check` เดียว (verify_jwt:false, ใช้ service_role)
--   — anon ต้องมีสิทธิ์ตาราง "เป็นศูนย์" เสมอ ไม่มี grant ไม่มี policy ให้ anon แม้แต่บรรทัดเดียวในไฟล์นี้
--   ทีมงาน (admin/staff จาก profiles) ทำงานคิวผ่าน db.ts ตามปกติ (authenticated + RLS)
--
-- คำตัดสินเจ้าของ 2026-09-23 (ดู scratchpad credit-check-decisions.md):
--   1) auth ร้าน = รหัสร้าน (login code) + PIN 6 หลัก, แอดมินตั้ง/รีเซ็ตให้ (เก็บ hash เท่านั้น)
--   2) รายได้ < 4 เท่างวด → 🟡 ต้องตรวจ (ไม่ fail อัตโนมัติ) ช่วง pilot
--   3) ฟรีแลนซ์/ไม่มีสลิปเงินเดือน → 🟡 เสมอ (มีรูปหลักฐานทำงานประกอบ)
--   4) เก็บ 90 วันถ้าไม่กลายเป็นสัญญา แล้วลบไฟล์+PII ทิ้ง / ผูกสัญญาแล้ว = เก็บถาวรคู่สัญญา
--   5) ต้องประหยัดพื้นที่ DB (free plan 500 MB)
--   6) ร้านนำร่อง: จ่าอั๋นโฟน สาขา 2/4
--   7) เป้าตอบสนอง 3 นาที — วัด first_opened_at/decided_at เทียบ created_at
--
-- ⚠️ ออกแบบเบี่ยงจาก brief ที่จุดเดียว (ตั้งใจ เพื่อความปลอดภัย — ดูรายงานที่ส่งพร้อม migration นี้):
--   brief ขอ "shops: เพิ่มคอลัมน์ ... credit_pin_hash ... credit_pin_rotated_at" ตรงบนตาราง shops
--   แต่ src/lib/db.ts (getShops, บรรทัด ~439) ทำ `select('*')` จากตาราง shops ตรงๆ ทุกหน้าที่ staff เปิด
--   ถ้า credit_pin_hash อยู่บน shops แถวนั้นจะหลุดไปที่ browser ของ staff/freelancer ทุกคนทันที (แม้ hash
--   จะเป็น bcrypt แต่ PIN มีแค่ 6 หลัก = 1,000,000 ความเป็นไปได้ ถอดได้เร็วถ้า hash หลุด)
--   → ย้าย credit_pin_hash/rotated_at/rotated_by ไปตาราง shop_credit_pin แยก (RLS ปิดสนิท ไม่มี policy
--   ให้ authenticated แม้แต่ admin — เข้าได้เฉพาะผ่าน RPC SECURITY DEFINER 2 ตัว: admin_set_shop_credit_pin
--   (SECTION 3) + verify_shop_credit_login (SECTION 5)). ส่วน credit_login_code (เหมือน username ไม่ใช่
--   ความลับ) + credit_check_enabled (flag ธรรมดา) ยังอยู่บน shops ตามเดิม ปลอดภัยที่จะเห็นคู่กับข้อมูลร้าน
--   อื่นที่ staff เห็นอยู่แล้ว (bank/account_no ก็อยู่ตรงนั้น)
--
-- Additive/idempotent ทั้งหมด — ไม่แตะ/ลบตาราง คอลัมน์ หรือ policy เดิม
--
-- แก้ตามรีวิวติ๊ก (รอบ 1, ก่อน apply):
--   [RED] pgcrypto อยู่ schema `extensions` บน prod ไม่ใช่ public — ฟังก์ชันที่ตั้ง search_path=public ล้วน
--     จะหา crypt()/gen_salt()/gen_random_bytes() ไม่เจอ (function does not exist) → schema-qualify ทุกจุด
--     ที่เรียกเป็น extensions.crypt(...)/extensions.gen_salt(...)/extensions.gen_random_bytes(...) และตั้ง
--     search_path = public, extensions บนฟังก์ชันที่ใช้ pgcrypto (admin_set_shop_credit_pin,
--     verify_shop_credit_login) — schema-qualify ซ้ำอีกชั้นเป็น defense-in-depth ตาม house style
--     0083/0136 ("ไม่พึ่ง search_path ของ session") ฟังก์ชันอื่นที่ไม่ยุ่ง pgcrypto คง search_path=public เดิม
--   [RED] revoke ... from anon เฉยๆ เป็น no-op เพราะ Postgres grant EXECUTE ให้ PUBLIC pseudo-role โดย
--     default ตอนสร้างฟังก์ชันใหม่ทุกตัว (anon เป็นสมาชิก PUBLIC โดยปริยาย) — ต้อง revoke from public ด้วย
--     เสมอถึงจะตัดสิทธิ์จริง (admin_set_shop_credit_pin เป็นจุดที่พลาด แก้แล้วใน SECTION 3 — ฟังก์ชันอื่น
--     ที่ revoke from public, anon, authenticated ไว้แต่แรกแล้วไม่ต้องแก้)
--   [YELLOW→ทำเลย] PIN/login code เดิมใช้ random() (ไม่ใช่ CSPRNG) → เปลี่ยนมาใช้
--     extensions.gen_random_bytes() แทนทั้งคู่ (login code: 1 byte/ตัวอักษร mod 32 ไม่มี bias เพราะ
--     256 หาร 32 ลงตัวพอดี; PIN: 4 bytes ต่อกันเป็นเลข mod 1,000,000 — bias น้อยมากที่ติ๊กบอกว่ารับได้)
--   [เพิ่มเอง] lockout: PIN ผิดติดกัน >=5 ครั้งใน 15 นาที → ปฏิเสธทันทีไม่แตะ crypt() เลย ใช้
--     credit_check_rate_log เดิม + คอลัมน์ success ใหม่ (ไม่ต้องสร้างตารางเพิ่ม) — ทำให้ SECTION rate limit
--     (เดิมอยู่ท้ายไฟล์) ต้องย้ายมาไว้ก่อน verify_shop_credit_login (SECTION 4 ใหม่) เพราะฟังก์ชันหลังต้อง
--     insert ลงตารางนี้ — เปลี่ยนเลข SECTION 5-10 ทั้งหมดขยับ +0/-0 ตามลำดับใหม่ด้านล่าง (ดูหัวข้อแต่ละ
--     SECTION ตรงๆ ไม่ต้องเทียบกับรอบก่อน)
--   [แถมจากการแก้ lockout] verify_shop_credit_login ต้อง insert (เขียน DB) ทุกครั้งที่เรียกแล้ว → เอา
--     `stable` ออก (เดิม mislabel เป็น stable ทั้งที่ไม่มี side effect ตอนนั้น) ให้เป็น volatile (default)
--     ตามจริง — เพิ่ม parameter p_ip_hash เข้าไปด้วยสำหรับ log
--   [แก้ตามรีวิวติ๊ก รอบ 2] lockout เดิมคีย์แค่ shop_id เฉยๆ → เปลี่ยนเป็นคีย์คู่ (shop_id, ip_hash) ทั้ง
--     query นับ failed attempt และ partial index credit_check_rate_log_shop_fail_idx เพื่อไม่ให้เครื่อง
--     เดียวที่ทายผิดรัวๆ ไปล็อกร้านทั้งร้านออกจากทุกเครื่อง/ทุก IP — คง 30/ชม.ต่อร้าน + 60/ชม.ต่อ IP (SECTION 4)
--     ไว้เป็น backstop กว้างเหมือนเดิม (ครอบเคส IP เดียวไล่ทายหลายร้าน ซึ่ง lockout คู่นี้ตรวจไม่เจอ)

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- SECTION 1: shops — เพิ่ม credit_login_code (ไม่ลับ) + credit_check_enabled (pilot gate)
-- หมายเหตุ: shops.code (0001) ไม่มี unique constraint (ยืนยันใน 0044 บรรทัด 4) — ห้ามเอามาใช้เป็น
-- login credential เพราะซ้ำกันได้ (ใช้จับคู่ PJ เท่านั้น) → สร้างคอลัมน์ใหม่แยกสำหรับ login โดยเฉพาะ
-- ============================================================================

alter table public.shops
  add column if not exists credit_login_code text,
  add column if not exists credit_check_enabled boolean not null default false;

comment on column public.shops.credit_login_code is
  'รหัสร้านสำหรับ login หน้าฟอร์มเช็คเครดิตสาธารณะ (ไม่ใช่ความลับ เหมือน username) — สร้างอัตโนมัติครั้งแรกที่แอดมินกด "ตั้ง/รีเซ็ต PIN" ผ่าน admin_set_shop_credit_pin(). แยกจาก shops.code เพราะ code ไม่ unique (0044)';
comment on column public.shops.credit_check_enabled is
  'เปิดใช้ฟีเจอร์เช็คเครดิตเองให้ร้านนี้ (pilot gate) — เจ้าของเลือกจ่าอั๋นโฟน สาขา 2/4 ก่อน (2026-09-23)';

create unique index if not exists shops_credit_login_code_key
  on public.shops (credit_login_code) where credit_login_code is not null;

-- ============================================================================
-- SECTION 2: shop_credit_pin — เก็บ PIN hash แยกจาก shops (ดูเหตุผลด้านบน)
-- ไม่มี RLS policy ให้ authenticated เลยแม้แต่ admin — เข้าได้เฉพาะทาง SECURITY DEFINER RPC
-- (ฟังก์ชันรันในฐานะ owner ข้าม RLS ได้ปกติ) หรือ service_role (0017 default privileges)
-- ============================================================================

create table if not exists public.shop_credit_pin (
  shop_id     uuid primary key references public.shops (id) on delete cascade,
  pin_hash    text not null,
  rotated_at  timestamptz not null default now(),
  rotated_by  uuid references public.profiles (id) on delete set null
);

comment on table public.shop_credit_pin is
  'PIN (bcrypt hash) สำหรับ login ฟอร์มเช็คเครดิตของร้าน — แยกจาก shops เพื่อกัน select(*) ปกติของ staff/freelancer หลุด hash ไปที่ browser. อ่าน/เขียนได้ทาง admin_set_shop_credit_pin() + verify_shop_credit_login() เท่านั้น (SECURITY DEFINER) ไม่มี RLS policy ให้ authenticated โดยตรง';

alter table public.shop_credit_pin enable row level security;
-- ไม่สร้าง policy ใดๆ ให้ authenticated โดยเจตนา — RLS เปิดแต่ไม่มี policy = ปฏิเสธทุก role ที่ไม่ bypass RLS
-- (service_role/postgres มี rolbypassrls=true อยู่แล้ว ตามที่ 0132 ยืนยันไว้)

-- defense-in-depth: revoke grant ระดับตารางจาก authenticated/anon ด้วย แม้ RLS จะกันอยู่แล้ว
-- (0005 ALTER DEFAULT PRIVILEGES ให้ authenticated ได้ select/insert/update/delete บนตารางใหม่ทุกตัวอัตโนมัติ)
revoke all on public.shop_credit_pin from authenticated, anon;
grant select, insert, update, delete on public.shop_credit_pin to service_role;

-- ============================================================================
-- SECTION 3: RPC admin_set_shop_credit_pin — แอดมินตั้ง/รีเซ็ต PIN ให้ร้าน คืนค่า plaintext ครั้งเดียว
-- สร้าง credit_login_code อัตโนมัติถ้ายังไม่มี (charset ตัด 0/O, 1/I กันสับสน)
-- RNG: extensions.gen_random_bytes() (CSPRNG) แทน random() — ทั้ง login code และ PIN
--   login code: 1 byte/ตัวอักษร แล้ว mod 32 → ไม่มี modulo bias (256 หาร 32 ลงตัวเป๊ะ)
--   PIN: 4 bytes ต่อกันเป็นเลข 32-bit แล้ว mod 1,000,000 → bias น้อยมาก (~1/4295) ติ๊กรับได้ตามรีวิว
-- search_path = public, extensions: ให้เรียก crypt()/gen_salt()/gen_random_bytes() เจอแน่นอน (pgcrypto
--   อยู่ schema extensions บน prod) แต่ยัง schema-qualify ตรงจุดเรียกจริงซ้ำอีกชั้น (extensions.xxx) กัน
--   session/role อื่นที่อาจ override search_path (defense-in-depth ตามรีวิวติ๊ก)
-- ============================================================================

create or replace function public.admin_set_shop_credit_pin(p_shop_id uuid)
returns table (login_code text, pin text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_login_code text;
  v_pin        text;
  v_tries      int := 0;
  v_rand       bytea;
  v_num        bigint;
  v_charset    text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 ตัว ตัด 0/O, 1/I กันสับสน
  i            int;
begin
  if not is_admin() then
    raise exception using errcode = '42501',
      message = 'เฉพาะแอดมินเท่านั้นที่ตั้ง/รีเซ็ต PIN ร้านค้าได้';
  end if;

  if not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'ไม่พบร้านค้ารหัสนี้';
  end if;

  select s.credit_login_code into v_login_code
  from public.shops s where s.id = p_shop_id;

  if v_login_code is null then
    loop
      v_tries := v_tries + 1;
      v_rand := extensions.gen_random_bytes(6);
      v_login_code := '';
      for i in 0..5 loop
        v_login_code := v_login_code || substr(v_charset, (get_byte(v_rand, i) % 32) + 1, 1);
      end loop;
      exit when not exists (
        select 1 from public.shops where credit_login_code = v_login_code
      );
      if v_tries > 20 then
        raise exception 'สร้างรหัสร้านไม่สำเร็จ (ชนกันซ้ำๆ) ลองกดใหม่อีกครั้ง';
      end if;
    end loop;
  end if;

  v_rand := extensions.gen_random_bytes(4);
  v_num := (get_byte(v_rand, 0)::bigint << 24)
         | (get_byte(v_rand, 1)::bigint << 16)
         | (get_byte(v_rand, 2)::bigint << 8)
         |  get_byte(v_rand, 3)::bigint;
  v_pin := lpad((v_num % 1000000)::text, 6, '0');

  update public.shops
    set credit_login_code = v_login_code
  where id = p_shop_id;

  insert into public.shop_credit_pin (shop_id, pin_hash, rotated_at, rotated_by)
  values (p_shop_id, extensions.crypt(v_pin, extensions.gen_salt('bf')), now(), auth.uid())
  on conflict (shop_id) do update
    set pin_hash   = excluded.pin_hash,
        rotated_at = now(),
        rotated_by = auth.uid();

  return query select v_login_code, v_pin;
end;
$$;

comment on function public.admin_set_shop_credit_pin(uuid) is
  '(0164) แอดมินตั้ง/รีเซ็ต PIN เช็คเครดิตของร้าน — คืน login_code + pin แบบ plaintext ครั้งเดียว (ไม่เก็บ plaintext ที่ไหนอีก) ต้อง is_admin() เท่านั้น RNG ใช้ extensions.gen_random_bytes (CSPRNG)';

-- แก้ตามรีวิวติ๊ก: revoke จาก anon เฉยๆ เป็น no-op เพราะ Postgres grant EXECUTE ให้ PUBLIC โดย default ตอน
-- สร้างฟังก์ชัน (anon เป็นสมาชิก PUBLIC โดยปริยาย) — ต้อง revoke from public ด้วยเสมอ แล้วค่อย grant คืนเฉพาะ
-- authenticated (is_admin() เช็คภายในอีกชั้น — grant ระดับ role คุมแค่ "ใครเรียกได้" ไม่ใช่ "ใครทำสำเร็จ")
revoke all on function public.admin_set_shop_credit_pin(uuid) from public, anon;
grant execute on function public.admin_set_shop_credit_pin(uuid) to authenticated;

-- ============================================================================
-- SECTION 4: rate limit ต่อร้าน + ต่อ IP + log ผลทุก attempt (ย้ายมาก่อน verify_shop_credit_login เพราะ
-- SECTION 5 ต้อง insert ลงตารางนี้เพื่อทำ lockout — ดูหัวไฟล์ "เพิ่มเอง") service_role เท่านั้นที่แตะได้
-- ============================================================================

create table if not exists public.credit_check_rate_log (
  id         bigint generated always as identity primary key,
  shop_id    uuid references public.shops (id) on delete cascade,
  ip_hash    text,
  success    boolean,        -- null = แค่นับอัตรา (credit_check_rate_limit_ok) / true,false = ผลตรวจ PIN จริงจาก verify_shop_credit_login (ใช้ทำ lockout)
  created_at timestamptz not null default now()
);

create index if not exists credit_check_rate_log_shop_idx on public.credit_check_rate_log (shop_id, created_at desc);
create index if not exists credit_check_rate_log_ip_idx on public.credit_check_rate_log (ip_hash, created_at desc);
-- lockout คีย์ด้วย (shop_id, ip_hash) ไม่ใช่แค่ shop_id (ติ๊กรีวิวรอบ 2) — เครื่องที่ทายผิดไม่ล็อก
-- เครื่องอื่นที่ใช้ login_code เดียวกันของร้านทิ้งไว้ (เช่น พนักงานร้านคนละคนพิมพ์ผิดคนละที่)
create index if not exists credit_check_rate_log_shop_fail_idx
  on public.credit_check_rate_log (shop_id, ip_hash, created_at desc) where success = false;

comment on table public.credit_check_rate_log is
  '(0164) log ทุก attempt: credit_check_rate_limit_ok() (success=null, นับอัตราทั่วไปต่อร้าน/ต่อ IP) + verify_shop_credit_login() (success=true/false, ใช้ทำ lockout PIN ผิดติดกัน >=5 ครั้ง/15 นาที คีย์ด้วย shop_id+ip_hash คู่กัน) ไม่มี policy ให้ authenticated/anon เลย';

alter table public.credit_check_rate_log enable row level security;
-- ไม่สร้าง policy ให้ authenticated/anon โดยเจตนา (เหมือน shop_credit_pin)
revoke all on public.credit_check_rate_log from authenticated, anon;
grant select, insert, update, delete on public.credit_check_rate_log to service_role;

create or replace function public.credit_check_rate_limit_ok(
  p_shop_id           uuid,
  p_ip_hash           text,
  p_shop_limit        int default 30,
  p_ip_limit          int default 60,
  p_window_minutes    int default 60
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_count int := 0;
  v_ip_count   int := 0;
  v_ok         boolean;
begin
  if p_shop_id is not null then
    select count(*) into v_shop_count
    from public.credit_check_rate_log
    where shop_id = p_shop_id
      and created_at >= now() - make_interval(mins => p_window_minutes);
  end if;

  if p_ip_hash is not null then
    select count(*) into v_ip_count
    from public.credit_check_rate_log
    where ip_hash = p_ip_hash
      and created_at >= now() - make_interval(mins => p_window_minutes);
  end if;

  v_ok := v_shop_count < p_shop_limit and v_ip_count < p_ip_limit;

  -- log ทุก attempt ไม่ว่าจะผ่านหรือไม่ (เห็นภาพย้อนหลัง) — success = null (นี่คือ pre-check ไม่ใช่ผล PIN)
  insert into public.credit_check_rate_log (shop_id, ip_hash)
  values (p_shop_id, p_ip_hash);

  return v_ok;
end;
$$;

comment on function public.credit_check_rate_limit_ok(uuid, text, int, int, int) is
  '(0164) เช็ค+log rate limit ต่อร้าน (default 30/ชม.) และต่อ IP hash (default 60/ชม.) ก่อน Edge Function credit-check เรียก verify_shop_credit_login — เรียกฟังก์ชันนี้ก่อนเสมอเพื่อกัน brute-force PIN 6 หลัก service_role เท่านั้นที่เรียกได้';

revoke all on function public.credit_check_rate_limit_ok(uuid, text, int, int, int) from public, anon, authenticated;
grant execute on function public.credit_check_rate_limit_ok(uuid, text, int, int, int) to service_role;

-- ============================================================================
-- SECTION 5: RPC verify_shop_credit_login — ให้ Edge Function credit-check เรียกด้วย service_role เท่านั้น
-- ตรวจ code+PIN+active+credit_check_enabled + lockout PIN ผิดติดกัน >=5 ครั้งใน 15 นาที คีย์ด้วย
-- (shop_id, ip_hash) คู่กัน (ติ๊กรีวิวรอบ 2 — เดิมคีย์แค่ shop_id เฉยๆ) ไม่งั้นเครื่องหนึ่งทายผิดรัวๆ จะไปล็อก
-- ร้านทั้งร้านออกจากทุกเครื่อง (รวมเครื่องที่ไม่เกี่ยวข้อง) — 30/ชม. ต่อร้าน + 60/ชม. ต่อ IP ที่ SECTION 4
-- ยังเป็น backstop กว้างกว่าเดิมเผื่อ IP เดียวไล่ทาย login_code หลายร้าน
-- (rate-limit อัตราทั่วไปอยู่ที่ SECTION 4 — Edge Function เรียก credit_check_rate_limit_ok ก่อนเสมอ
-- แยกจาก lockout เฉพาะ PIN ผิดในฟังก์ชันนี้ เพราะต้องรู้ผล PIN ก่อนถึงจะนับได้ว่า "ผิด" — สองชั้นนี้ตอบโจทย์
-- คนละอย่าง ไม่ทับซ้อนกัน)
-- ไม่ใช่ stable แล้ว (เขียน credit_check_rate_log ทุกครั้งที่เรียก) — volatile (default) ถูกต้องกว่า
-- ============================================================================

create or replace function public.verify_shop_credit_login(
  p_login_code text,
  p_pin        text,
  p_ip_hash    text default null
)
returns table (shop_id uuid, shop_name text, ok boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_shop_id    uuid;
  v_shop_name  text;
  v_hash       text;
  v_active     boolean;
  v_enabled    boolean;
  v_fail_count int;
begin
  select s.id, s.name, s.active, s.credit_check_enabled, p.pin_hash
    into v_shop_id, v_shop_name, v_active, v_enabled, v_hash
  from public.shops s
  join public.shop_credit_pin p on p.shop_id = s.id
  where s.credit_login_code = p_login_code;

  -- lockout: PIN ผิดติดกัน >=5 ครั้งใน 15 นาทีที่ผ่านมา คีย์ด้วย (shop_id, ip_hash) คู่กัน → ปฏิเสธทันที
  -- ไม่แตะ crypt() เลย (กัน brute force ต่อ + ไม่เผา CPU กับ bcrypt โดยเปล่าประโยชน์ตอนล็อกอยู่แล้ว)
  -- คีย์คู่ (ไม่ใช่แค่ shop_id) เพราะเครื่องหนึ่งทายผิดไม่ควรล็อกร้านทั้งร้านออกจากทุกเครื่อง/ทุก IP —
  -- sliding window เพราะ log ถูกเขียนต่อแม้กำลังล็อกอยู่ — ยิ่งพยายามต่อ (IP เดิม) ยิ่งล็อกยาวออกไปเรื่อยๆ
  -- โดยไม่ต้องมีตาราง lockout แยก (IP อื่นของร้านเดียวกันไม่ถูกล็อกไปด้วย)
  if v_shop_id is not null then
    select count(*) into v_fail_count
    from public.credit_check_rate_log
    where shop_id = v_shop_id
      and ip_hash = p_ip_hash
      and success = false
      and created_at >= now() - interval '15 minutes';

    if v_fail_count >= 5 then
      insert into public.credit_check_rate_log (shop_id, ip_hash, success)
        values (v_shop_id, p_ip_hash, false);
      return query select null::uuid, null::text, false;
      return;
    end if;
  end if;

  if v_shop_id is null or v_active is not true or v_enabled is not true then
    if v_shop_id is not null then
      insert into public.credit_check_rate_log (shop_id, ip_hash, success)
        values (v_shop_id, p_ip_hash, false);
    end if;
    return query select null::uuid, null::text, false;
    return;
  end if;

  if v_hash is null or extensions.crypt(p_pin, v_hash) <> v_hash then
    insert into public.credit_check_rate_log (shop_id, ip_hash, success)
      values (v_shop_id, p_ip_hash, false);
    return query select null::uuid, null::text, false;
    return;
  end if;

  insert into public.credit_check_rate_log (shop_id, ip_hash, success)
    values (v_shop_id, p_ip_hash, true);
  return query select v_shop_id, v_shop_name, true;
end;
$$;

comment on function public.verify_shop_credit_login(text, text, text) is
  '(0164) ตรวจ login code + PIN ของร้าน สำหรับ Edge Function credit-check เท่านั้น (service_role) — เช็ค active + credit_check_enabled ด้วย ไม่ใช่แค่ PIN ตรง. lockout อัตโนมัติถ้า PIN ผิด >=5 ครั้งใน 15 นาที คีย์ด้วย (shop_id, ip_hash) คู่กัน (นับจาก credit_check_rate_log.success=false) เป็น sliding window — IP อื่นของร้านเดียวกันไม่โดนล็อกไปด้วย ต้องพึ่ง p_ip_hash ที่ Edge Function ส่งมาให้ถูกต้องเสมอ (ถ้าส่ง null lockout จะไม่ทำงาน เหลือแค่ rate cap หยาบที่ SECTION 4)';

revoke all on function public.verify_shop_credit_login(text, text, text) from public, anon, authenticated;
grant execute on function public.verify_shop_credit_login(text, text, text) to service_role;

-- ============================================================================
-- SECTION 6: credit_checks — 1 แถวต่อคำขอเช็คเครดิต 1 ครั้ง
-- ============================================================================

create table if not exists public.credit_checks (
  id                    uuid primary key default gen_random_uuid(),
  shop_id               uuid not null references public.shops (id) on delete restrict,

  -- ข้อมูลลูกค้าที่ร้านกรอก
  customer_name         text not null,
  national_id           text not null,
  national_id_digits    text generated always as (
                          regexp_replace(coalesce(national_id, ''), '[^0-9]', '', 'g')
                        ) stored,
  id_type               text not null default 'thai' check (id_type in ('thai', 'foreign')),
  id_expiry             date,
  birth_date            date,
  occupation_type       text,
  declared_income       numeric,
  device_price          numeric,
  device_down           numeric,
  term_months           int,
  our_installment       numeric,
  pj_installment        numeric,
  facebook_url          text,

  -- consent + ผู้ส่ง
  consent_at            timestamptz,
  consent_text_version  text,
  submitter_ip_hash     text,

  -- ผลเครื่องคำนวณอัตโนมัติ (engine — pure function จาก src/lib ตาม CLAUDE.md ห้ามคำนวณเลขธุรกิจซ้ำใน SQL,
  -- ตารางนี้แค่ "เก็บผลลัพธ์" ที่ Edge Function คำนวณมาแล้วเท่านั้น ไม่มี logic คำนวณเงื่อนไขอยู่ในตารางนี้)
  engine_level          text check (engine_level in ('fail', 'needs_review', 'passed_preliminary')),
  engine_reasons        jsonb not null default '[]'::jsonb,
  engine_ratio          numeric,

  -- ตรวจมือโดย staff
  blacklist_result      text not null default 'not_checked' check (blacklist_result in ('not_checked', 'clear', 'found')),
  blacklist_checked_by  uuid references public.profiles (id) on delete set null,
  blacklist_checked_at  timestamptz,
  facebook_result       text not null default 'not_checked' check (facebook_result in ('not_checked', 'confirmed', 'mismatch')),
  facebook_checked_by   uuid references public.profiles (id) on delete set null,
  facebook_checked_at   timestamptz,

  -- คำตัดสินสุดท้าย
  decision              text check (decision in ('approved', 'rejected', 'need_more_info')),
  decision_note         text,
  decided_by            uuid references public.profiles (id) on delete set null,
  decided_at            timestamptz,

  -- วัดเวลาตอบสนอง (เป้า 3 นาที)
  first_opened_at       timestamptz,
  first_opened_by       uuid references public.profiles (id) on delete set null,

  -- auto-link กับสัญญาที่เกิดขึ้นจริง
  contract_id           uuid references public.contracts (id) on delete set null,

  -- retention: null = ยังไม่ผูกสัญญา แต่ตั้งใจรอ (ผูกแล้ว trigger จะเซ็ตเป็น null ให้เก็บถาวร)
  purge_after           date default (current_date + 90),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists credit_checks_shop_idx on public.credit_checks (shop_id, created_at desc);
create index if not exists credit_checks_national_id_digits_idx on public.credit_checks (national_id_digits);
create index if not exists credit_checks_contract_idx on public.credit_checks (contract_id) where contract_id is not null;
create index if not exists credit_checks_purge_idx on public.credit_checks (purge_after) where contract_id is null and purge_after is not null;

comment on table public.credit_checks is
  '(0164) คำขอเช็คเครดิตที่ร้านส่งผ่านฟอร์มสาธารณะ (credit-check Edge Function, service_role insert เท่านั้น) — staff/admin ตรวจ blacklist/Facebook แล้วตัดสินใจ. purge_after ใช้กับ purge_expired_credit_checks() (90 วันถ้าไม่ผูกสัญญา — คำตัดสินเจ้าของ 2026-09-23)';
comment on column public.credit_checks.engine_level is
  'ผลเครื่องคำนวณเบื้องต้น: fail=❌ไม่ผ่านชัดเจน(อายุไม่ถึง/เอกสารหมดอายุ) / needs_review=🟡ต้องตรวจ(รายได้<4เท่างวด, ฟรีแลนซ์, ไม่มีสลิป) / passed_preliminary=🟢ผ่านเบื้องต้น รอ staff ยืนยัน blacklist+Facebook — ห้ามบอกร้านว่า "อนุมัติแล้ว" (คำตัดสินเจ้าของ: ต้องพูดว่า "รอทีมยืนยัน")';
comment on column public.credit_checks.purge_after is
  'null = ผูกสัญญาแล้ว เก็บถาวรคู่สัญญา (trigger เซ็ตให้อัตโนมัติ) — ไม่ null = ยังไม่ผูก รอ purge_expired_credit_checks() ลบทิ้งเมื่อเลยวันนี้';

-- BEFORE UPDATE: บังคับ updated_at (pattern เดียวกับ touch_queue_case_seen ใน 0047)
create or replace function public.touch_credit_check_updated_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_credit_check_updated_at on public.credit_checks;
create trigger trg_touch_credit_check_updated_at
  before update on public.credit_checks
  for each row execute function public.touch_credit_check_updated_at();

alter table public.credit_checks enable row level security;

-- SELECT/UPDATE: admin + staff เท่านั้น (freelance role ไม่มีสิทธิ์ — ไม่ OR is_freelancer() ตามที่สั่ง)
-- INSERT/DELETE: ไม่มี policy ให้ authenticated เลย — เขียนได้ทาง service_role (Edge Function) เท่านั้น
drop policy if exists credit_checks_select on public.credit_checks;
create policy credit_checks_select
  on public.credit_checks
  for select to authenticated
  using (is_admin() or is_staff());

drop policy if exists credit_checks_update on public.credit_checks;
create policy credit_checks_update
  on public.credit_checks
  for update to authenticated
  using (is_admin() or is_staff())
  with check (is_admin() or is_staff());

-- defense-in-depth: ตัด insert/delete grant จาก authenticated ตรงๆ (0005 ให้มาโดย default) เผื่อ policy พลาด
revoke insert, delete on public.credit_checks from authenticated;
revoke all on public.credit_checks from anon;
grant select, insert, update, delete on public.credit_checks to service_role;

-- ============================================================================
-- SECTION 7: credit_check_files — ไฟล์แนบเก็บบน R2 (ตาม media-sign wave 6) เก็บแค่ metadata ที่นี่
-- ไม่มี Supabase storage bucket ในไฟล์นี้ — R2 key/presign เป็นงานของ Edge Function ในอนาคต
-- ============================================================================

create table if not exists public.credit_check_files (
  id               uuid primary key default gen_random_uuid(),
  credit_check_id  uuid not null references public.credit_checks (id) on delete cascade,
  kind             text not null check (kind in (
                     'payslip', 'statement', 'work_photo', 'facebook_screenshot', 'id_card', 'other'
                   )),
  r2_key           text not null,
  mime             text,
  size             int,
  sha256           text,
  created_at       timestamptz not null default now()
);

create index if not exists credit_check_files_check_idx on public.credit_check_files (credit_check_id);

comment on table public.credit_check_files is
  '(0164) metadata ไฟล์แนบของคำขอเช็คเครดิต (ไฟล์จริงอยู่ R2 — r2_key ชี้ path ตามที่ media-sign ใช้ presign) เขียนได้ทาง service_role เท่านั้น staff/admin อ่านได้อย่างเดียว';

alter table public.credit_check_files enable row level security;

drop policy if exists credit_check_files_select on public.credit_check_files;
create policy credit_check_files_select
  on public.credit_check_files
  for select to authenticated
  using (is_admin() or is_staff());

revoke insert, update, delete on public.credit_check_files from authenticated;
revoke all on public.credit_check_files from anon;
grant select, insert, update, delete on public.credit_check_files to service_role;

-- ============================================================================
-- SECTION 8: v_credit_check_queue — หน้าคิว staff (national_id มาสก์ + นาทีที่รอ)
-- security_invoker=on: RLS ของ credit_checks/shops (ผู้เรียกจริง) มีผลตามปกติ ไม่ bypass
-- ============================================================================

create or replace view public.v_credit_check_queue
  with (security_invoker = on) as
select
  cc.id,
  cc.shop_id,
  s.name as shop_name,
  cc.customer_name,
  case
    when length(cc.national_id_digits) <= 4 then cc.national_id_digits
    else repeat('x', length(cc.national_id_digits) - 4) || right(cc.national_id_digits, 4)
  end as national_id_masked,
  cc.id_type,
  cc.engine_level,
  cc.engine_ratio,
  cc.blacklist_result,
  cc.facebook_result,
  cc.decision,
  cc.decision_note,
  cc.contract_id,
  cc.created_at,
  cc.first_opened_at,
  cc.decided_at,
  round(extract(epoch from (coalesce(cc.first_opened_at, now()) - cc.created_at)) / 60.0, 1) as minutes_to_first_open,
  round(extract(epoch from (coalesce(cc.decided_at, now()) - cc.created_at)) / 60.0, 1) as minutes_to_decision
from public.credit_checks cc
join public.shops s on s.id = cc.shop_id;

comment on view public.v_credit_check_queue is
  '(0164) หน้าคิว staff/admin ตรวจคำขอเช็คเครดิต — national_id มาสก์เหลือ 4 ตัวท้าย, minutes_to_first_open/minutes_to_decision ใช้วัดเป้าตอบสนอง 3 นาที (คำตัดสินเจ้าของ 2026-09-23)';

grant select on public.v_credit_check_queue to authenticated;
grant select on public.v_credit_check_queue to service_role;

-- ============================================================================
-- SECTION 9: auto-link — AFTER INSERT ON contracts จับคู่ credit_checks ที่ยังไม่ผูก
-- ⚠️ trigger นี้วิ่งทุกครั้งที่มีการสร้างสัญญา (AddContract, import batch, contract transfer ฯลฯ) —
-- ห้าม raise exception ออกไปเด็ดขาด ไม่งั้นสัญญาทั้งบริษัทสร้างไม่ได้ ครอบทั้งฟังก์ชันด้วย exception handler
-- ============================================================================

create or replace function public.credit_check_autolink_from_contract()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_digits   text;
  v_check_id uuid;
begin
  if new.national_id is null or new.shop_id is null then
    return new;
  end if;

  v_digits := regexp_replace(new.national_id, '[^0-9]', '', 'g');
  if v_digits = '' then
    return new;
  end if;

  select cc.id into v_check_id
  from public.credit_checks cc
  where cc.shop_id = new.shop_id
    and cc.national_id_digits = v_digits
    and cc.contract_id is null
    and cc.created_at >= new.created_at - interval '60 days'
    and cc.created_at <= new.created_at
  order by cc.created_at desc
  limit 1;

  if v_check_id is not null then
    update public.credit_checks
      set contract_id = new.id,
          purge_after = null
    where id = v_check_id;
  end if;

  return new;
exception when others then
  -- กันคำขอเช็คเครดิตหาย/บั๊กที่นี่ทำสัญญาทั้งบริษัทสร้างไม่ได้ — log แล้วปล่อยผ่าน
  raise warning 'credit_check_autolink_from_contract failed for contract %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_credit_check_autolink on public.contracts;
create trigger trg_credit_check_autolink
  after insert on public.contracts
  for each row execute function public.credit_check_autolink_from_contract();

comment on function public.credit_check_autolink_from_contract() is
  '(0164) จับคู่สัญญาใหม่กับ credit_checks ที่ยังไม่ผูก (เลขบัตร digits-only + shop_id เดียวกัน + ภายใน 60 วัน, เลือกแถวใหม่สุดถ้าชนกันหลายแถว) — wrap exception ทั้งฟังก์ชัน ห้ามพัง contracts insert path เด็ดขาด';

-- backfill ครั้งเดียว (ปลอดภัย เป็น no-op ตอนนี้เพราะ credit_checks ยังว่าง — เผื่อรันซ้ำหลังมีข้อมูลจริง
-- แล้วอยากจับคู่ย้อนหลัง ก่อนรันจริงควร dry-run นับแถวก่อน)
-- เลือก "สัญญาที่สร้างหลัง credit_check และใหม่สุดในกรอบ 60 วัน" ต่อ 1 credit_check (กันผูกมั่ว 1:หลายคู่)
with candidates as (
  select
    cc.id as credit_check_id,
    c.id  as contract_id,
    row_number() over (partition by cc.id order by c.created_at desc) as rn
  from public.credit_checks cc
  join public.contracts c
    on c.shop_id = cc.shop_id
   and regexp_replace(coalesce(c.national_id, ''), '[^0-9]', '', 'g') = cc.national_id_digits
   and cc.national_id_digits <> ''
   and c.created_at >= cc.created_at
   and c.created_at <= cc.created_at + interval '60 days'
  where cc.contract_id is null
)
update public.credit_checks cc
set contract_id = cand.contract_id,
    purge_after = null
from candidates cand
where cand.rn = 1
  and cc.id = cand.credit_check_id;

-- ============================================================================
-- SECTION 10: purge_expired_credit_checks — ลบ PII+ไฟล์ metadata ที่หมดอายุ คืน r2_key ให้ Edge Function/
-- cron ในอนาคตไปลบไฟล์จริงบน R2 ต่อ (ไฟล์นี้ไม่ตั้ง cron/ไม่ลบ R2 จริง — schema เท่านั้น)
-- ============================================================================

create or replace function public.purge_expired_credit_checks(p_limit int default 100)
returns table (credit_check_id uuid, r2_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  select array_agg(s.id) into v_ids
  from (
    select cc.id
    from public.credit_checks cc
    where cc.contract_id is null
      and cc.purge_after is not null
      and cc.purge_after < current_date
    order by cc.purge_after
    limit greatest(p_limit, 0)
  ) s;

  if v_ids is null or array_length(v_ids, 1) is null then
    return;
  end if;

  -- re-check contract_id is null ตอนลบจริง (กัน race: trigger auto-link ผูกสัญญาแทรกกลางคัน)
  return query
  delete from public.credit_check_files f
  where f.credit_check_id = any(v_ids)
    and exists (
      select 1 from public.credit_checks c2
      where c2.id = f.credit_check_id and c2.contract_id is null
    )
  returning f.credit_check_id, f.r2_key;

  delete from public.credit_checks cc
  where cc.id = any(v_ids)
    and cc.contract_id is null
    and cc.purge_after is not null
    and cc.purge_after < current_date;
end;
$$;

comment on function public.purge_expired_credit_checks(int) is
  '(0164) ลบแถว credit_checks/credit_check_files ที่ contract_id is null และ purge_after < วันนี้ (90 วัน — คำตัดสินเจ้าของ 2026-09-23) คืน r2_key ให้ Edge Function/cron ในอนาคตไปลบไฟล์จริงบน R2 ต่อ (ไฟล์นี้ไม่ลบ R2 จริง ไม่สร้าง cron) service_role เท่านั้นที่เรียกได้ — re-check contract_id is null ตอนลบจริงกัน race กับ trigger auto-link';

revoke all on function public.purge_expired_credit_checks(int) from public, anon, authenticated;
grant execute on function public.purge_expired_credit_checks(int) to service_role;

-- ============================================================================
-- SECTION 11: Verify checklist สำหรับครีม (รันหลัง apply — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================

-- 11a) pgcrypto อยู่ schema extensions จริง (สมมติฐานตั้งต้นของรีวิวติ๊ก — เช็คก่อนอย่างอื่นทั้งหมด):
-- SELECT extname, extnamespace::regnamespace FROM pg_extension WHERE extname = 'pgcrypto';
-- expected: extnamespace = extensions (ถ้าเป็น public แปลว่าโปรเจกต์นี้ไม่เหมือนที่ติ๊กเช็ค ต้องกลับไปทบทวน
-- search_path ของทุกฟังก์ชันที่เรียก crypt/gen_salt/gen_random_bytes อีกรอบ)

-- 11b) service_role เข้าตารางใหม่ได้ครบ (Edge Function จะพังถ้าไม่ผ่าน):
-- SELECT has_table_privilege('service_role', 'public.credit_checks', 'SELECT');       -- true
-- SELECT has_table_privilege('service_role', 'public.credit_checks', 'INSERT');       -- true
-- SELECT has_table_privilege('service_role', 'public.credit_check_files', 'INSERT');  -- true
-- SELECT has_table_privilege('service_role', 'public.shop_credit_pin', 'SELECT');     -- true
-- SELECT has_table_privilege('service_role', 'public.credit_check_rate_log', 'INSERT'); -- true

-- 11c) anon ต้องเป็นศูนย์ทุกตารางใหม่ (หัวใจของงานนี้):
-- SELECT has_table_privilege('anon', 'public.credit_checks', 'SELECT');       -- expected: false
-- SELECT has_table_privilege('anon', 'public.credit_checks', 'INSERT');       -- expected: false
-- SELECT has_table_privilege('anon', 'public.credit_check_files', 'SELECT'); -- expected: false
-- SELECT has_table_privilege('anon', 'public.shop_credit_pin', 'SELECT');    -- expected: false
-- SELECT has_table_privilege('anon', 'public.credit_check_rate_log', 'SELECT'); -- expected: false
-- SELECT has_function_privilege('anon', 'public.verify_shop_credit_login(text,text,text)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('anon', 'public.admin_set_shop_credit_pin(uuid)', 'EXECUTE'); -- expected: false (ตัวนี้คือจุดที่ติ๊กจับได้ว่าพลาด — ต้อง false แล้วหลังแก้)
-- SELECT has_function_privilege('anon', 'public.purge_expired_credit_checks(int)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('anon', 'public.credit_check_rate_limit_ok(uuid,text,int,int,int)', 'EXECUTE'); -- expected: false

-- 11d) PUBLIC pseudo-role เองก็ต้องไม่มี EXECUTE เหลือ (นี่คือสิ่งที่ revoke จาก anon เฉยๆ พลาดไปตอนแรก):
-- SELECT has_function_privilege('public', 'public.admin_set_shop_credit_pin(uuid)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('public', 'public.verify_shop_credit_login(text,text,text)', 'EXECUTE'); -- expected: false

-- 11e) authenticated ต้องเข้าไม่ได้ทั้ง insert/delete บน credit_checks/credit_check_files, เข้าไม่ได้เลยบน
-- shop_credit_pin/credit_check_rate_log แม้เป็น admin (RLS ปิดสนิท ต้องผ่าน RPC เท่านั้น):
-- SELECT has_table_privilege('authenticated', 'public.credit_checks', 'INSERT'); -- expected: false
-- SELECT has_table_privilege('authenticated', 'public.credit_checks', 'DELETE'); -- expected: false
-- SELECT has_table_privilege('authenticated', 'public.shop_credit_pin', 'SELECT'); -- expected: false (grant ระดับตาราง)
--   (RLS ปิดกั้นซ้ำอีกชั้นแม้ grant หลุด — verify ด้วย SET ROLE authenticated ถ้าต้องการความชัวร์เพิ่ม)

-- 11f) service_role only functions ต้องเรียกไม่ได้จาก authenticated:
-- SELECT has_function_privilege('authenticated', 'public.verify_shop_credit_login(text,text,text)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('authenticated', 'public.purge_expired_credit_checks(int)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('authenticated', 'public.credit_check_rate_limit_ok(uuid,text,int,int,int)', 'EXECUTE'); -- expected: false

-- 11g) admin RPC เรียกได้เฉพาะ admin จริง (ทดสอบด้วยบัญชี staff ต้องเจอ error 42501) + crypt ใช้ได้จริง
-- (ถ้า search_path ผิดจะเจอ "function crypt(text,text) does not exist" ตรงนี้ก่อนใครเพื่อน):
-- SELECT * FROM admin_set_shop_credit_pin('90a7fd38-0021-4d01-be08-86185e044894'); -- ร้านจ่าอั๋นโฟน สาขา 4

-- 11h) unique index ทำงาน (สร้าง PIN ให้ 2 ร้านนำร่องแล้ว credit_login_code ต้องไม่ซ้ำกัน):
-- SELECT id, name, credit_login_code, credit_check_enabled FROM shops
--   WHERE id IN ('90a7fd38-0021-4d01-be08-86185e044894', 'f2ad470b-9eb6-46bc-858e-def367bb07a9');

-- 11i) lockout ทำงานจริง + คีย์ด้วย (shop_id, ip_hash) คู่กัน (เรียกด้วย service_role key ตรงๆ ทดสอบ —
-- ห้ามทดสอบผ่าน anon key เด็ดขาด):
-- SELECT * FROM verify_shop_credit_login('<login_code จาก 11h>', '000000', 'ip-A'); -- ทำซ้ำ 5 ครั้ง (ผิด)
-- SELECT * FROM verify_shop_credit_login('<login_code จาก 11h>', '<pin ถูกจริง>', 'ip-A');
-- expected: ครั้งที่ 6 เป็นต้นไปจาก ip-A เป็น ok=false แม้ PIN ถูก (ล็อกเฉพาะ ip-A) จนกว่าจะพ้น 15 นาที
-- ไม่มี attempt ใหม่จาก ip-A
-- SELECT * FROM verify_shop_credit_login('<login_code จาก 11h>', '<pin ถูกจริง>', 'ip-B');
-- expected: ip-B ไม่ถูกล็อก (คนละ ip_hash) — ok=true ทันทีถ้า PIN ถูก แม้ ip-A ยังล็อกอยู่ (พิสูจน์ว่าคีย์คู่
-- ทำงานจริง ไม่ได้ล็อกทั้งร้าน)
-- SELECT count(*) FROM credit_check_rate_log WHERE shop_id = '<shop_id>' AND ip_hash = 'ip-A' AND success = false; -- ต้อง >= 5

-- 11j) view queue อ่านได้ + มาสก์ถูกต้อง (ต้อง login เป็น staff/admin ก่อน):
-- SELECT * FROM v_credit_check_queue ORDER BY created_at DESC LIMIT 5;

-- 11k) trigger auto-link ไม่พัง contracts insert ปกติ (smoke: สร้างสัญญาทดสอบที่ national_id ไม่ตรงกับ
-- credit_checks ใดๆ ต้องสร้างผ่านตามปกติ ไม่มี error, ไม่มี credit_checks แถวไหนถูกผูกผิด):
-- INSERT INTO contracts (contract_no, customer_name, national_id, shop_id, ...) VALUES (...);
-- SELECT count(*) FROM credit_checks WHERE contract_id = '<new-contract-id>'; -- expected: 0 (ไม่มี credit_check ที่ match)
