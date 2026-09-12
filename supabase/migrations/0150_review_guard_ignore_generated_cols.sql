-- 0150: แก้บั๊ก Guard B ของระบบตรวจเคส (contracts_review_guard) บล็อกเกินจริง — บล็อก staff แก้ "อะไรก็ได้"
-- บนสัญญา approved แล้ว รวมถึงคอลัมน์ที่ตั้งใจยกเว้นไว้ (email_sent_at/email_sent_by) ทำให้ปุ่ม
-- "บันทึกว่าส่งเอง (สำรอง)" (WaitingEmail.tsx doMarkSent/markEmailSent) พังสำหรับ staff มาตั้งแต่ 0143
--
-- รากบั๊ก: public.contracts มีคอลัมน์ GENERATED ALWAYS AS ... STORED 3 ตัว (after_down, commission_amount,
-- net_transfer — ดู 0001_init.sql) Postgres คำนวณคอลัมน์ generated "หลัง" BEFORE trigger ทำงาน ดังนั้นภายใน
-- BEFORE UPDATE trigger นี้ NEW.<generated> เป็น NULL เสมอ (ไม่ว่า UPDATE จะแก้อะไร) ขณะที่ OLD.<generated>
-- มีค่าจริงอยู่แล้ว ผลคือ to_jsonb(new) - whitelist กับ to_jsonb(old) - whitelist "ต่างกันเสมอ" ที่ 3 คอลัมน์นี้
-- แม้ staff จะแค่บันทึก email_sent_at (ซึ่ง whitelist ไว้แล้ว) → Guard B เข้าใจผิดว่ามีการแก้คอลัมน์อื่นจริง
-- แล้ว raise exception 'เคสนี้ตรวจผ่านแล้ว แก้ไขไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน' ทั้งที่ staff ไม่ได้แก้อะไรเลย
-- (พิสูจน์แล้วบน production ด้วย probe trigger — ดูผลในข้อความที่คุณเตย/ครีมส่งมาให้ก่อนไฟล์นี้)
--
-- นี่คือ over-block (fail-safe เกินจำเป็น ไม่ใช่ช่องโหว่ความปลอดภัย) แต่พังฟีเจอร์จริงที่รับปากคุณเตยไว้ว่า
-- "เคส approved ยังส่งได้ปกติทั้ง 2 ปุ่ม" — ต้องแก้ก่อน push งานของน้องวิวที่รอ 0149/0150 คู่กัน
--
-- ทางแก้: ตัดคอลัมน์ GENERATED ทั้ง 3 ตัวออกจากการเทียบของ Guard B ทั้ง 2 ฝั่ง (new/old) ให้สมมาตร —
-- ไม่แตะ Guard A / Guard C / early-return ใดๆ เลย (copy verbatim จาก 0149 ทุกบรรทัด ยกเว้น Guard B)
--
-- Additive/idempotent — create or replace function (คงชื่อ/trigger เดิม), drop trigger if exists ก่อนสร้างใหม่
-- ไม่แตะตาราง/คอลัมน์/ข้อมูลใดๆ

-- ============================================================================
-- SECTION 1: ฟังก์ชันเก็บรายชื่อคอลัมน์ GENERATED บน public.contracts (single source of truth)
--
-- ทำไม hardcode ในฟังก์ชันแยก แทนที่จะ query information_schema/pg_attribute สดทุกครั้ง:
-- contracts_review_guard() เป็น BEFORE UPDATE FOR EACH ROW trigger บนตารางที่ถูกแก้บ่อยที่สุดในระบบ
-- (ทุกหน้าที่แก้สัญญา, RPC ผ่อน/ปรับ/ปิดเคสจำนวนมากก็ผ่าน UPDATE contracts) ถ้า query
-- information_schema.columns หรือ pg_attribute (attgenerated <> '') ทุกแถวที่ UPDATE จะมี catalog lookup
-- เพิ่มต่อแถวจริง ๆ (ต่าง SQL statement คนละ transaction, planner cache ต่อ statement เท่านั้น ไม่ใช่ต่อ session)
-- ส่วนทางเลือกที่ cache ผลไว้ (เช่น ผ่าน statement-level trigger คำนวณครั้งเดียวแล้วยัดใส่ temp table/GUC
-- ให้ per-row trigger อ่าน) แก้ปัญหา perf ได้ แต่เพิ่ม state/ความซับซ้อนใน trigger ที่บั๊กต้องเนียนมาก (เหมือน
-- 0143 ที่ผ่านรีวิว diff ไปได้เพราะ logic เขียนถูกแต่ "สมมติฐานเรื่อง generated column" ผิด) — เพิ่ม surface
-- ให้บั๊กแบบเดิมเกิดซ้ำในรูปแบบใหม่ ไม่คุ้มกับที่ประหยัดได้ (แค่ตัด 3 ชื่อคอลัมน์ตายตัวออกจาก jsonb)
--
-- จึงเลือก hardcode แบบตายตัว แต่ยกออกมาเป็นฟังก์ชันเดี่ยว (ไม่ inline อยู่ในตัว guard) เพื่อ:
--   1) มี 1 จุดเดียวที่ต้องแก้ถ้ามีคอลัมน์ generated ใหม่ (ไม่ต้องไล่หาใน logic ของ guard)
--   2) `language sql immutable` — planner สามารถ inline/constant-fold ได้ ต้นทุนใกล้ 0 (คนละเรื่องกับ
--      query catalog สด) ไม่ต่างจาก array literal ตรงๆ ในเชิง perf
--   3) comment ติดอยู่ที่ฟังก์ชันนี้โดยเฉพาะ — เจอง่ายเวลา `\df+` หรือ grep ชื่อฟังก์ชันตอนรีวิว migration ใหม่
--
-- ⚠️⚠️ ถ้าเพิ่มคอลัมน์ GENERATED ใหม่บน public.contracts ในอนาคต (generated always as ... stored)
-- ต้องมาเพิ่มชื่อคอลัมน์ในอาเรย์ข้างล่างนี้ด้วยเสมอ — ไม่ทำ = Guard B จะ over-block กลับมาอีก (fail-safe
-- ผิดทาง ไม่ใช่ช่องโหว่ แต่พังฟีเจอร์เงียบๆ เหมือนบั๊กที่ไฟล์นี้แก้อยู่) เช็คว่าคอลัมน์ generated ปัจจุบันมีอะไรบ้าง
-- ด้วย query นี้ (มีอยู่ใน checklist ท้ายไฟล์ด้วย):
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'contracts' and is_generated <> 'NEVER';
-- ============================================================================

create or replace function public.contracts_generated_columns()
returns text[]
language sql
immutable
as $$
  select array['after_down', 'commission_amount', 'net_transfer'];
$$;

comment on function public.contracts_generated_columns() is
  '(0150) รายชื่อคอลัมน์ GENERATED ALWAYS AS ... STORED ทั้งหมดบน public.contracts ณ ปัจจุบัน (after_down, commission_amount, net_transfer จาก 0001_init.sql) — hardcode ตั้งใจ (เหตุผล perf/ความซับซ้อน ดู comment SECTION 1 ของ 0150) ใช้ตัดออกจาก Guard B ของ contracts_review_guard() ก่อนเทียบ to_jsonb(new) vs to_jsonb(old) เพราะ Postgres คำนวณคอลัมน์ generated หลัง BEFORE trigger ทำให้ NEW.<generated> เป็น NULL เสมอ ⚠️ เพิ่มคอลัมน์ generated ใหม่บน contracts ต้องมาเพิ่มในอาเรย์นี้ด้วย เช็คด้วย: select column_name from information_schema.columns where table_schema=''public'' and table_name=''contracts'' and is_generated <> ''NEVER'';';

-- ============================================================================
-- SECTION 2: contracts_review_guard() — Guard A + Guard C copy verbatim จาก 0149 (ห้ามแก้แม้ตัวอักษรเดียว)
-- Guard B (แก้เฉพาะจุดนี้): ตัดคอลัมน์ generated ออกจากทั้ง 2 ฝั่ง (new/old) ก่อนเทียบ — สมมาตร
-- คอลัมน์ต้นทาง (device_price, down_percent, commission_percent, doc_fee) "ไม่ถูกตัด" ยังอยู่ในการเทียบ
-- ตามปกติ — staff ยังแก้คอลัมน์เหล่านี้บนเคส approved ไม่ได้เหมือนเดิม (ดูเคส (ฉ) ในสคริปต์ทดสอบ)
-- ============================================================================

create or replace function public.contracts_review_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate_from text;
begin
  -- ยกเว้น service_role ทั้งหมด (Edge Function send-company-email ต้อง stamp
  -- email_sent_at/email_sent_by บนสัญญา approved ได้ผ่าน service-role client — ดู 0142/send-company-email)
  -- เช็ค 2 ทาง: current_user (role ที่ต่อ DB จริงตอนใช้ SUPABASE_SERVICE_ROLE_KEY ผ่าน PostgREST)
  -- และ request.jwt.claim.role (GUC ที่ PostgREST/Data API ตั้งจาก JWT role claim) — กันพลาดถ้าฝั่งใดฝั่งหนึ่ง
  -- ไม่ตรงตามที่คาด (เช่น ต่อผ่าน connection pooler ที่ตั้ง role คนละแบบ)
  if current_user = 'service_role'
     or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  then
    return new;
  end if;

  -- ยกเว้นทุก request ที่ไม่มี user login (auth.uid() เป็น null) — ครอบคลุม service_role (กันซ้ำจากเช็คด้านบน),
  -- เจ้าของ table (migration/MCP ที่รันเป็น Postgres owner ไม่ใช่ service_role), และ cron/Edge context อื่นๆ
  -- เหตุผล: browser client ของ staff/admin ทุกตัวแนบ JWT เสมอ ดังนั้น auth.uid() ต้อง non-null ทุก request
  -- จากฝั่ง staff จริง — null คือไม่ใช่ threat model ของ guard นี้ (staff เข้าตาราง contracts ไม่ได้เลยถ้าไม่มี JWT
  -- เพราะ RLS policy เดิมของ contracts เองก็ require is_admin()/is_staff() ซึ่ง lookup profiles ผ่าน auth.uid())
  -- ผลคือ: manual SQL fix ที่ครีม/ติ๊กรันผ่าน apply_migration MCP (เป็น owner ไม่ใช่ service_role) แก้คอลัมน์อื่น
  -- ของสัญญา approved แล้วได้ตามปกติ ไม่โดน Guard B บล็อกอีกต่อไป
  if auth.uid() is null then
    return new;
  end if;

  -- Guard A: review_status / review_updated_at / review_updated_by เปลี่ยนได้ทาง RPC เท่านั้น
  -- RPC ทั้ง 3 ตัว (0142) ตั้ง app.review_rpc='1' แบบ transaction-local ก่อน update ทุกครั้ง (SECTION 2)
  if (new.review_status is distinct from old.review_status)
     or (new.review_updated_at is distinct from old.review_updated_at)
     or (new.review_updated_by is distinct from old.review_updated_by)
  then
    if coalesce(current_setting('app.review_rpc', true), '') <> '1' then
      raise exception 'สถานะการตรวจเปลี่ยนได้ผ่านปุ่มในระบบเท่านั้น';
    end if;
  end if;

  -- Guard B (0150 — แก้ over-block): เคส approved แล้ว — staff (ไม่ใช่แอดมิน) แก้คอลัมน์อื่นของสัญญาไม่ได้
  -- ยกเว้น review_* (คุมโดย Guard A ไปแล้ว), email_sent_at/email_sent_by (canSendEmail ใน src/lib/review.ts
  -- ตั้งใจให้ staff กดปุ่ม "ส่งเมล/บันทึกว่าส่งเอง" ได้ตอน approved โดยไม่ต้องเป็นแอดมิน) และคอลัมน์ GENERATED
  -- ทั้ง 3 ตัว (public.contracts_generated_columns() — เหตุผลทำไมต้องตัด ดู comment หัวไฟล์นี้ + SECTION 1):
  -- Postgres คำนวณคอลัมน์ generated "หลัง" BEFORE trigger จึง NEW.<generated> เป็น NULL เสมอในทริกเกอร์นี้
  -- ไม่ว่า UPDATE จะแก้อะไรก็ตาม — ถ้าไม่ตัดออก Guard B จะเห็นว่า new/old ต่างกันเสมอที่ 3 คอลัมน์นี้ (NULL vs
  -- ค่าจริง) แล้ว over-block ทุก UPDATE บนเคส approved รวมถึง email_sent_at ที่ whitelist ไว้แล้ว (บั๊กเดิม)
  --
  -- ⚠️ คอลัมน์ "ต้นทาง" ของ generated (device_price, down_percent, commission_percent, doc_fee) ไม่ได้อยู่ใน
  -- รายการที่ตัดออก — ยังถูกเทียบตามปกติ staff แก้คอลัมน์เหล่านี้บนเคส approved ยังโดนบล็อกเหมือนเดิม (ส่วน
  -- การแก้คอลัมน์ generated ตรงๆ เช่น "update contracts set after_down = 1" Postgres ปฏิเสธเองอยู่แล้ว ไม่ต้อง
  -- พึ่ง guard นี้เลย เพราะเป็นคอลัมน์ GENERATED ALWAYS ห้าม insert/update ตรงโดยธรรมชาติของ Postgres)
  if old.review_status = 'approved' and not public.is_admin() then
    if (to_jsonb(new) - (array[
          'review_status', 'review_updated_at', 'review_updated_by',
          'email_sent_at', 'email_sent_by'
        ]::text[] || public.contracts_generated_columns()))
       is distinct from
       (to_jsonb(old) - (array[
          'review_status', 'review_updated_at', 'review_updated_by',
          'email_sent_at', 'email_sent_by'
        ]::text[] || public.contracts_generated_columns()))
    then
      raise exception 'เคสนี้ตรวจผ่านแล้ว แก้ไขไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน';
    end if;
  end if;

  -- Guard C (0149): กัน stamp/re-stamp email_sent_at ตรงบนสัญญา post-cutoff ที่ยังไม่ approved —
  -- ปิดบั๊ก 3 สัญญาส่งเมลหลุด (ดู comment หัวไฟล์). predicate ครอบ NULL->non-NULL และ re-stamp
  -- (non-NULL->non-NULL ค่าใหม่) ด้วย — ช่องที่เปิดอยู่คือ: approved -> ส่งเมล (stamp email_sent_at) ->
  -- แอดมินกด reject_review -> review_status='needs_fix' (0142:327 ไม่ล้าง email_sent_at เดิม) -> ตอนนี้
  -- staff PATCH email_sent_at เป็นค่าใหม่ได้ (Guard B ไม่ยิงเพราะ old.review_status ไม่ใช่ 'approved'
  -- แล้ว) ถ้า predicate แคบแค่ NULL->non-NULL จะไม่ครอบเคสนี้
  --
  -- เจตนา: ยังให้แอดมินเคลียร์ email_sent_at กลับเป็น NULL ได้ตามปกติ (pendingDocuments ใน db.ts ล้างค่านี้
  -- เป็นส่วนหนึ่งของ flow เก่า) — Guard C เช็คเฉพาะทิศ "ตั้งค่า" ไม่เช็คทิศ "ล้างค่า"
  --
  -- ไม่ยกเว้น is_admin() และไม่ยกเว้นเมื่อมีแถวใน contract_media_gate_override โดยตั้งใจ — override (0137)
  -- แปลว่า "รูปไม่ครบแต่ให้ผ่านเกทรูป" เท่านั้น ไม่ใช่ "ข้ามการตรวจของคุณเตย" (media_gate_complete ใน 0142
  -- SECTION 3 honor override นี้อยู่แล้วตอน submit_for_review จึงไม่มี deadlock ที่ชั้น DB — เคส bypass
  -- ยัง submit -> approve ได้ตามปกติ ไม่ต้องมีทางออกฉุกเฉินที่ Guard C)
  --
  -- ⚠️ กับดักฝั่ง client ที่ยังไม่ live (comment เตือนไว้ ไม่ใช่งานรอบนี้): ContractDetail.tsx ไม่เคยอ่าน
  -- contract_media_gate_override ตอนนี้ (0 แถวทั้งตาราง ณ วันที่เขียนไฟล์นี้) ปุ่ม "ส่งให้คุณเตยตรวจ" จะเทา
  -- ถ้ารูปไม่ครบแม้แอดมินกด override ไว้แล้ว — วันใดเริ่มมีแถว override จริง ต้องไปเพิ่มตัวอ่าน override
  -- ฝั่ง frontend ก่อน ไม่งั้นเคสนั้นจะส่งเมลไม่ได้ตลอดกาล (ผ่าน DB gate ได้ แต่เข้า pending_review ไม่ได้
  -- เพราะปุ่มเทา)
  if new.email_sent_at is not null
     and new.email_sent_at is distinct from old.email_sent_at
  then
    select value into v_gate_from from public.app_settings where key = 'media_gate_from';
    v_gate_from := coalesce(v_gate_from, '2026-09-09'); -- ต้องตรงกับ 0142:118 และ Edge index.ts:180 เป๊ะๆ

    if old.created_at is not null
       and (old.created_at at time zone 'utc')::date >= v_gate_from::date
       and old.review_status is distinct from 'approved'
    then
      raise exception 'เคสนี้ยังไม่ผ่านการตรวจ ส่งเมลไม่ได้ ให้กดปุ่มส่งให้คุณเตยตรวจที่หน้าสัญญาก่อน';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.contracts_review_guard() is
  '(0143+0149+0150) BEFORE UPDATE guard บน contracts: Guard A กัน review_status/review_updated_at/review_updated_by ถูกเขียนตรงนอก RPC 0142; Guard B กัน staff แก้คอลัมน์อื่นของสัญญา approved แล้ว ยกเว้น email_sent_at/by และคอลัมน์ generated (0150 — ดู contracts_generated_columns()); Guard C (0149) กัน stamp/re-stamp email_sent_at บนสัญญา post-cutoff (media_gate_from) ที่ review_status ยังไม่ approved — ไม่ยกเว้น admin/override โดยตั้งใจ (ดู comment ในฟังก์ชัน) — ยกเว้น service_role ทั้งหมด และยกเว้นทุก request ที่ auth.uid() เป็น null (owner/MCP/cron/Edge)';

-- ตัวนี้แก้ function เดิม ไม่ใช่สร้าง trigger ใหม่ — แต่ drop/create ซ้ำเพื่อความชัดเจน+idempotent
-- (contracts มี BEFORE UPDATE trigger ตัวเดียวชื่อ contracts_review_guard เหมือนเดิมหลัง apply)
drop trigger if exists contracts_review_guard on public.contracts;
create trigger contracts_review_guard
  before update on public.contracts
  for each row execute function public.contracts_review_guard();

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) trigger ยังมีตัวเดียวบน contracts (ไม่ได้เพิ่ม trigger ที่สอง):
-- select count(*) from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = 'contracts_review_guard';
-- expected: 1

-- b) รายชื่อคอลัมน์ generated ในฟังก์ชัน ต้องตรงกับที่มีอยู่จริงบน contracts เป๊ะ (ไม่ขาด/ไม่เกิน):
-- select public.contracts_generated_columns();
-- expected: {after_down,commission_amount,net_transfer}
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'contracts' and is_generated <> 'NEVER'
--   order by column_name;
-- expected: after_down, commission_amount, net_transfer — ตรงกับข้างบน 3/3

-- c) รันสคริปต์ทดสอบเจาะ (scratchpad/0149_guard_c_smoke_test.sql ฉบับอัปเดต 0150) ต้องได้ PASS ทั้ง 7 เคส
-- (ก)-(ฉ) รวมเคส (ฉ) ใหม่ที่พิสูจน์ว่า Guard B ยังบล็อกคอลัมน์ต้นทาง (device_price) บนเคส approved

-- d) service_role อัปเดต email_sent_at บนสัญญา approved ต้องผ่าน (send-company-email ใช้ path นี้):
-- select has_table_privilege('service_role', 'public.contracts', 'UPDATE'); -- expected: true

-- e) owner/MCP อัปเดตคอลัมน์อื่น (ไม่ใช่ review_*/email_sent_*) บนสัญญา approved แล้ว ต้องสำเร็จ (auth.uid() เป็น null):
--   update public.contracts set monthly_payment = monthly_payment where id = '<contract_id_approved>';
--   expected: สำเร็จ (ไม่ error) — รันผ่าน apply_migration MCP/Postgres owner ไม่มี JWT session
