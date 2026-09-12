-- 0151: เคสที่ยังไม่ผ่านตรวจ (review_status ≠ 'approved') กดสรุปยอดส่งร้านไม่ได้ — กันที่ trigger
-- ────────────────────────────────────────────────────────────────────────────
-- ช่องโหว่ (คุณเตยเคาะให้ปิด 2026-09-12): mark_summary_shop_sent (0105) เป็น SECURITY INVOKER + plain
-- UPDATE ไม่มี guard เรื่อง review_status เลยสักชั้น — และ staff ยิง REST `PATCH /contracts
-- {summary_shop_sent_at}` ตรงได้ด้วย (RLS contracts_update ของ 0095 อนุญาต admin OR staff กว้างๆ)
-- ผลคือเคสที่รูปไม่ครบ/ยังไม่ส่งให้คุณเตยตรวจ สามารถถูกสรุปยอด → เงินโอนให้ร้านออกไปได้โดยไม่มีใครเห็นก่อน
--
-- แก้ที่ trigger เดียวกับ Guard A/B/C (public.contracts_review_guard, 0143/0149/0150) เพิ่ม Guard D —
-- กันทุกทาง (RPC 0105 / REST PATCH ตรง / SQL มือ) พร้อมกันในจุดเดียว ไม่ต้องไล่แก้ RPC เดิม
--
-- ปุ่มฉุกเฉิน (คุณเตยสั่งให้มี): เคสตรวจไม่ผ่านจริงๆ (รูปหายถาวร/ลูกค้าหายตัว) ต้องมีทางออก ไม่งั้นเงินร้าน
-- ค้างถาวร → RPC ใหม่ force_mark_summary_shop_sent (admin เท่านั้น + เหตุผลบังคับ ≥10 ตัวอักษร + log)
--
-- 🔒 กันเฉพาะรอบ 1 (ส่งร้าน summary_shop_sent_at) เท่านั้น — ไม่แตะรอบ 2 (ส่งบัญชี
-- summary_accounting_sent_at) คุณเตยเคาะ: กันด่านก่อนเงินออกพอ ถ้ากันรอบ 2 ด้วยเคสที่ค้างในคอลัมน์ขวา
-- (สรุปยอดร้านไปแล้วก่อนมีระบบตรวจ) จะติดหมด
--
-- 🔴 ห้ามแตะ 3 สัญญาที่เคยหลุดส่งเมล (S00052PNQ001, S00026PNQ014, S00029PNQ037) — ไฟล์นี้ไม่แก้ข้อมูล
-- สัญญาใดๆ เป็น trigger + RPC ใหม่เท่านั้น ไม่กระทบ 3 เคสนั้นอยู่แล้ว
--
-- Additive/idempotent — create or replace function (คงชื่อ/trigger เดิม), drop trigger if exists ก่อน
-- สร้างใหม่, widen check constraint (เพิ่ม action ใหม่ ไม่ตัดของเดิม) ไม่แตะข้อมูล/คอลัมน์ใดๆ

-- ============================================================================
-- SECTION 1: contracts_review_guard() — Guard A + Guard B + Guard C copy verbatim จาก 0150
-- (ห้ามแก้แม้ตัวอักษรเดียว) + Guard D (ใหม่) ต่อท้าย ก่อน return new
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
  -- ทั้ง 3 ตัว (public.contracts_generated_columns() — เหตุผลทำไมต้องตัด ดู comment หัวไฟล์ 0150 + SECTION 1):
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
  -- ปิดบั๊ก 3 สัญญาส่งเมลหลุด (ดู comment หัวไฟล์ 0149). predicate ครอบ NULL->non-NULL และ re-stamp
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
    v_gate_from := coalesce(v_gate_from, '2026-09-09'); -- ต้องตรงกับ 0150:160 / db.ts:8807 / Edge index.ts:180 เป๊ะๆ

    if old.created_at is not null
       and (old.created_at at time zone 'utc')::date >= v_gate_from::date
       and old.review_status is distinct from 'approved'
    then
      raise exception 'เคสนี้ยังไม่ผ่านการตรวจ ส่งเมลไม่ได้ ให้กดปุ่มส่งให้คุณเตยตรวจที่หน้าสัญญาก่อน';
    end if;
  end if;

  -- Guard D (0151 — ใหม่): เคส post-cutoff ที่ยังไม่ approved ต้องกดสรุปยอดส่งร้าน (summary_shop_sent_at)
  -- ไม่ได้ — ปิดช่อง mark_summary_shop_sent (0105, SECURITY INVOKER, plain UPDATE ไม่มี guard เรื่องนี้)
  -- และ REST PATCH ตรงที่ RLS contracts_update (0095) อนุญาต staff กว้างๆ ไว้อยู่แล้ว
  --
  -- predicate ตั้งใจให้ทรง (shape) เดียวกับ Guard C ทุกประการ:
  --   - เช็คเฉพาะทิศ "ตั้งค่า" (new not null และต่างจาก old) — ทิศ "เคลียร์เป็น null" ไม่โดนบล็อก เพราะ
  --     rejectSummaryContract (db.ts:1003, บัญชีตีกลับเคส) และ bounce-back ของ pendingDocuments ต้อง
  --     เซ็ต summary_shop_sent_at กลับเป็น null ได้ปกติ ไม่งั้นฟีเจอร์เดิมพังเงียบ
  --   - gate ด้วย media_gate_from เทียบ created_at เหมือน Guard C — สัญญาเก่าก่อน cutoff ไม่โดนกฎนี้เลย
  --   - ไม่ยกเว้น is_admin() โดยตั้งใจ (เหมือน Guard C) — ทางออกเดียวที่ให้ผ่านคือ RPC ฉุกเฉิน
  --     force_mark_summary_shop_sent (SECTION 3) ซึ่งตั้ง GUC ธุรกรรม-เดียว 'app.force_summary_rpc'
  --     ก่อน UPDATE (pattern เดียวกับ app.review_rpc ของ Guard A, 0143) — ไม่ปิด trigger ทั้งตัว
  --
  -- service_role และ auth.uid() is null ได้รับการยกเว้นแล้วจาก early-return ด้านบนของฟังก์ชันนี้ (ไม่ต้อง
  -- เขียนซ้ำใน Guard D) — Edge Fn / MCP / data fix จึงไม่โดน Guard D บล็อก
  if new.summary_shop_sent_at is not null
     and new.summary_shop_sent_at is distinct from old.summary_shop_sent_at
     and coalesce(current_setting('app.force_summary_rpc', true), '') <> '1'
  then
    select value into v_gate_from from public.app_settings where key = 'media_gate_from';
    v_gate_from := coalesce(v_gate_from, '2026-09-09'); -- ต้องตรงกับ 0150:160 / db.ts:8807 / Edge index.ts:180 เป๊ะๆ

    if old.created_at is not null
       and (old.created_at at time zone 'utc')::date >= v_gate_from::date
       and old.review_status is distinct from 'approved'
    then
      raise exception 'เคสนี้ยังไม่ผ่านการตรวจ จึงยังสรุปยอดไม่ได้ค่ะ';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.contracts_review_guard() is
  '(0143+0149+0150+0151) BEFORE UPDATE guard บน contracts: Guard A กัน review_status/review_updated_at/review_updated_by ถูกเขียนตรงนอก RPC 0142; Guard B กัน staff แก้คอลัมน์อื่นของสัญญา approved แล้ว ยกเว้น email_sent_at/by และคอลัมน์ generated (0150); Guard C (0149) กัน stamp/re-stamp email_sent_at บนสัญญา post-cutoff ที่ยังไม่ approved; Guard D (0151) กัน stamp summary_shop_sent_at (สรุปยอดส่งร้าน) บนสัญญา post-cutoff ที่ยังไม่ approved — ทางออกเดียวคือ RPC force_mark_summary_shop_sent (admin+เหตุผล) ผ่าน GUC app.force_summary_rpc — ทั้ง Guard C/D ไม่ยกเว้น admin/override โดยตั้งใจ — ยกเว้น service_role ทั้งหมด และยกเว้นทุก request ที่ auth.uid() เป็น null (owner/MCP/cron/Edge)';

-- ตัวนี้แก้ function เดิม ไม่ใช่สร้าง trigger ใหม่ — แต่ drop/create ซ้ำเพื่อความชัดเจน+idempotent
-- (contracts มี BEFORE UPDATE trigger ตัวเดียวชื่อ contracts_review_guard เหมือนเดิมหลัง apply)
drop trigger if exists contracts_review_guard on public.contracts;
create trigger contracts_review_guard
  before update on public.contracts
  for each row execute function public.contracts_review_guard();

-- ============================================================================
-- SECTION 2: widen contract_review_log.action check constraint — เพิ่ม action ใหม่
-- 'force_summary_shop_sent' (0151) ต่อจากของเดิม 4 ค่า (0142) — additive ล้วนๆ ไม่ตัดของเดิม
-- ⚠️ ไม่แตะ src/lib/types.ts ContractReviewLogEntry['action'] union รอบนี้ — src/pages/ContractDetail.tsx
-- มี `Record<ContractReviewLogEntry['action'], string>` (REVIEW_ACTION_LABEL) ที่ต้องมีครบทุก key ถ้า
-- widen union ตรงนั้นจะพัง build ทันทีเพราะ key ใหม่ไม่มี label — เป็นงานของน้องวิวรอบหน้า (ห้ามแตะ
-- src/pages/* รอบนี้ตามที่สั่ง) ระหว่างนี้ db.ts mapReviewLog ใช้ `as ContractReviewLogEntry['action']`
-- (type assertion) อยู่แล้ว ไม่ error แม้ค่าจริงจาก DB ไม่ตรง union — ปลอดภัยแค่ยังไม่มี label โชว์
-- ============================================================================

alter table public.contract_review_log drop constraint if exists contract_review_log_action_check;
alter table public.contract_review_log add constraint contract_review_log_action_check
  check (action in ('submit', 'approve', 'reject', 'cancel_approval', 'force_summary_shop_sent'));

-- ============================================================================
-- SECTION 3: RPC ฉุกเฉิน force_mark_summary_shop_sent — admin เท่านั้น, เหตุผลบังคับ ≥10 ตัวอักษร
-- ============================================================================

create or replace function public.force_mark_summary_shop_sent(
  p_contract_id uuid,
  p_reason      text,
  p_date        date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_reason  text;
  v_ts      timestamptz;
  v_by      text;
begin
  -- admin เท่านั้น — ⚠️ is_admin() (0001_init.sql) ไม่เช็ค profiles.active=true (backlog เดิม รู้อยู่แล้ว
  -- ไม่แก้รอบนี้) แปลว่าแอดมินที่ถูกปิดบัญชี (active=false) แต่ session ยังไม่ expire จะเรียก RPC นี้ได้อยู่ —
  -- ถ้าจะปิดรูโหว่นี้ต้องแก้ is_admin() เอง (กระทบทุกที่ที่ใช้ ไม่ใช่ scope ของไฟล์นี้)
  if not public.is_admin() then
    raise exception 'เฉพาะแอดมินเท่านั้นที่สรุปยอดข้ามการตรวจได้';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if length(v_reason) < 10 then
    raise exception 'ต้องกรอกเหตุผลอย่างน้อย 10 ตัวอักษร ก่อนสรุปยอดข้ามการตรวจ';
  end if;

  select review_status into v_current from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญา';
  end if;

  -- 🔴 (ติ๊กจับ 09-12) เคสที่ "ยังไม่เคยส่งตรวจเลย" มี review_status เป็น NULL จริงๆ (0142 design — NULL
  -- ครอบทั้งสัญญาเก่า/draft) แต่ contract_review_log.to_status เป็น "not null" (0142 SECTION 2 line 48) —
  -- ถ้าไม่ coalesce ตรงนี้ insert ด้านล่างจะ violate not-null constraint แล้ว rollback ทั้ง UPDATE ที่ทำไปแล้ว
  -- (contract_review_log ไม่มี check constraint บนค่า from_status/to_status เลย มีแค่ NOT NULL บน to_status —
  -- เช็คแล้วใน 0142 ไม่ต้อง widen constraint ใดๆ) เลือก 'draft' เป็น sentinel เพราะเป็นค่าที่มีอยู่แล้วใน
  -- ReviewStatus union ฝั่ง TS (src/lib/review.ts) ที่ใช้แทน NULL อยู่แล้ว (ContractDetail.tsx:618
  -- reviewStatusForMachine = reviewStatusRaw ?? 'draft') — ไม่ใช่ค่าใหม่ที่ต้องเพิ่ม type ที่ไหนอีก
  -- coalesce ทั้งคู่ (ไม่ใช่แค่ to_status) เพราะ comment เดิมของฟังก์ชันนี้ยืนยันไว้แล้วว่า
  -- "from/to_status เหมือนกันเสมอสำหรับ action นี้" (RPC นี้ไม่แตะ contracts.review_status จริงเลย —
  -- สังเกตว่า contracts.review_status ยังเป็น NULL เหมือนเดิมหลัง RPC นี้ทำงาน ไม่ได้ถูกเปลี่ยนเป็น 'draft')
  v_current := coalesce(v_current, 'draft');

  select full_name into v_by from public.profiles where id = auth.uid();
  v_by := coalesce(v_by, 'แอดมิน');

  -- วันที่เลือก + เวลานาฬิกาปัจจุบัน (Bangkok) → timestamptz; null → now() (ตาม pattern mark_summary_shop_sent, 0105)
  if p_date is null then
    v_ts := now();
  else
    v_ts := (p_date + (now() at time zone 'Asia/Bangkok')::time) at time zone 'Asia/Bangkok';
  end if;

  -- เปิดทาง Guard D (SECTION 1) ให้ผ่าน — GUC ธุรกรรม-เดียว ไม่ปิด trigger ทั้งตัว (pattern เดียวกับ
  -- app.review_rpc ของ Guard A, 0143)
  perform set_config('app.force_summary_rpc', '1', true);

  -- mirror field เดียวกับ mark_summary_shop_sent (0105) ทุกตัว — auto-clear รอเอกสารเหมือนกัน
  update public.contracts
     set summary_shop_sent_at   = v_ts,
         summary_shop_sent_by   = v_by,
         summary_sent_at        = v_ts,
         summary_sent_by        = v_by,
         pending_documents      = false,
         documents_confirmed_at = v_ts,
         documents_confirmed_by = v_by
   where id = p_contract_id;

  -- append-only log (0142 SECTION 2 pattern) — from/to_status เหมือนกันเพราะ RPC นี้ไม่แตะ review_status
  -- เลย (ตั้งใจ — ไม่ใช่การ "ตรวจผ่าน" ปลอม แค่บันทึกว่าข้ามด่านสรุปยอดไปแล้วทำไม)
  insert into public.contract_review_log (contract_id, from_status, to_status, action, reason, actor, actor_role)
  values (p_contract_id, v_current, v_current, 'force_summary_shop_sent', v_reason, auth.uid(), 'admin');
end;
$$;

comment on function public.force_mark_summary_shop_sent(uuid, text, date) is
  '(0151) admin เท่านั้น, เหตุผลบังคับ ≥10 ตัวอักษร — ปุ่มฉุกเฉินสรุปยอดส่งร้านข้าม Guard D สำหรับเคสตรวจไม่ผ่านจริงๆ (รูปหายถาวร/ลูกค้าหายตัว) ไม่แตะ review_status เลย (ไม่ใช่การตรวจผ่านปลอม) เขียน contract_review_log action=force_summary_shop_sent ทุกครั้ง';

grant execute on function public.force_mark_summary_shop_sent(uuid, text, date) to authenticated;

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) trigger ยังมีตัวเดียวบน contracts (ไม่ได้เพิ่ม trigger ที่สอง):
-- select count(*) from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = 'contracts_review_guard';
-- expected: 1

-- b) contracts_generated_columns() ยังคืน 3 เหมือนเดิม (ไม่แตะ SECTION นี้จาก 0150):
-- select public.contracts_generated_columns();
-- expected: {after_down,commission_amount,net_transfer}

-- c) regression — รันสคริปต์ทดสอบเจาะ 7 เคสของ 0149/0150 (scratchpad/0149_guard_c_smoke_test.sql ฉบับ
-- อัปเดต 0150) ต้อง PASS หมดเหมือนเดิม (Guard A/B/C ไม่เปลี่ยนพฤติกรรม)

-- d) เคสใหม่ (ง.1) post-cutoff + ไม่ approved → UPDATE ตรงบล็อก (ทดสอบด้วย session staff/admin จริงที่มี JWT):
--   update public.contracts set summary_shop_sent_at = now() where id = '<contract_id_post_cutoff_not_approved>';
--   expected: ERROR เคสนี้ยังไม่ผ่านการตรวจ จึงยังสรุปยอดไม่ได้ค่ะ

-- e) เคสใหม่ (ง.2) pre-cutoff (created_at < media_gate_from) → UPDATE ผ่านปกติ (ไม่โดน Guard D เลย):
--   update public.contracts set summary_shop_sent_at = now() where id = '<contract_id_pre_cutoff>';
--   expected: สำเร็จ (ไม่ error)

-- f) เคสใหม่ (ง.3) เคลียร์ summary_shop_sent_at กลับเป็น null → ผ่านปกติ (ทิศ "ล้างค่า" ไม่โดน Guard D):
--   update public.contracts set summary_shop_sent_at = null where id = '<contract_id_ใดๆ>';
--   expected: สำเร็จ (ไม่ error) — ทดสอบให้ตรงกับ rejectSummaryContract (db.ts:1003)

-- g1) เคสใหม่ (ง.4a) RPC ฉุกเฉินโดย admin + เหตุผลครบ ≥10 ตัวอักษร บนเคส review_status = NULL (ยังไม่เคย
--     กด "ส่งให้คุณเตยตรวจ" เลยสักครั้ง) — เคสนี้คือตัวที่ชนบั๊ก to_status not-null เดิม (v_current เป็น
--     NULL ตรงๆ) ต้องหา contract_id ที่: review_status is null AND created_at >= media_gate_from
--     (post-cutoff ไม่งั้นไม่ผ่าน Guard D อยู่แล้วไม่ต้องพึ่ง RPC นี้) เช่น
--       select id from public.contracts
--         where review_status is null
--           and (created_at at time zone 'utc')::date >= (select value::date from public.app_settings where key='media_gate_from')
--         limit 1;
--     select public.force_mark_summary_shop_sent('<contract_id_review_status_null>'::uuid, 'รูปหายถาวร ลูกค้าติดต่อไม่ได้แล้ว', null);
--     expected: สำเร็จ (ก่อนแก้บั๊ก: ERROR null value in column "to_status" ... not-null constraint);
--     select * from public.contract_review_log where contract_id = '<...>' and action = 'force_summary_shop_sent'
--       order by created_at desc limit 1;
--     -- ต้องมี 1 แถวใหม่ + from_status = to_status = 'draft' (sentinel แทน NULL — ดู comment ในฟังก์ชัน)
--     -- และ contracts.review_status ของเคสนี้ต้องยังเป็น NULL เหมือนเดิม (RPC นี้ไม่แตะ review_status)
--
-- g2) เคสใหม่ (ง.4b) RPC ฉุกเฉินโดย admin + เหตุผลครบ บนเคส review_status = 'needs_fix' (เคยส่งตรวจ/ถูกตีกลับ
--     มาแล้ว) — เคสนี้ v_current ไม่ใช่ NULL อยู่แล้ว ไม่เคยชนบั๊กนี้ (ทดสอบไว้กันบั๊กใหม่ในอนาคตซ้ำที่เดิม)
--     หา contract_id ด้วย: select id from public.contracts where review_status = 'needs_fix' limit 1;
--     select public.force_mark_summary_shop_sent('<contract_id_needs_fix>'::uuid, 'รูปหายถาวร ลูกค้าติดต่อไม่ได้แล้ว', null);
--     expected: สำเร็จ; log ใหม่มี from_status = to_status = 'needs_fix' (ค่าจริง ไม่ใช่ sentinel เพราะไม่ใช่ NULL)

-- h) เคสใหม่ (ง.5) RPC ฉุกเฉินโดย non-admin หรือเหตุผลสั้น < 10 ตัวอักษร → ต้อง error:
--   select public.force_mark_summary_shop_sent('<contract_id>'::uuid, 'สั้น', null); -- session staff
--   expected: ERROR เฉพาะแอดมินเท่านั้นที่สรุปยอดข้ามการตรวจได้ (ถ้าไม่ใช่ admin)
--   หรือ ERROR ต้องกรอกเหตุผลอย่างน้อย 10 ตัวอักษร ก่อนสรุปยอดข้ามการตรวจ (ถ้าเป็น admin แต่เหตุผลสั้น)

-- i) sanity: media_gate_from อ่านได้ตรงกับที่คุณเตยยืนยัน:
-- select value from public.app_settings where key = 'media_gate_from';
-- expected: '2026-09-10'

-- j) contract_review_log action constraint ยอมรับค่าใหม่ (widen ไม่ตัดของเดิม):
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.contract_review_log'::regclass and conname = 'contract_review_log_action_check';
-- expected: check (action in ('submit','approve','reject','cancel_approval','force_summary_shop_sent'))

-- k) grant execute ครบ:
-- select has_function_privilege('authenticated', 'public.force_mark_summary_shop_sent(uuid, text, date)', 'EXECUTE');
-- expected: true

-- l) ⚠️ ห้ามรันข้อ d-h กับสัญญา S00052PNQ001 / S00026PNQ014 / S00029PNQ037 ในทุกกรณี — ห้ามแตะ 3 เคสนี้
