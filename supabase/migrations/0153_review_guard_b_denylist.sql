-- 0153: แก้ Guard B ของระบบตรวจเคส (contracts_review_guard) — deadlock กับ Guard D (0151)
-- ────────────────────────────────────────────────────────────────────────────
-- บั๊ก production (พบ 2026-09-13, พนักงานสรุปยอดส่งร้านไม่ได้เลยตั้งแต่ 12 ก.ย. — เงินร้านค้างสะสมทุกวัน):
--
-- Guard B (0143/0150) เดิมเป็น "allow-list" — staff แก้คอลัมน์ของสัญญา approved แล้วไม่ได้เลย
-- ยกเว้น 5 ชื่อ (review_status/review_updated_at/review_updated_by/email_sent_at/email_sent_by)
-- + คอลัมน์ generated 3 ตัว (0150) ส่วน Guard D (0151) ต้องให้ mark_summary_shop_sent (0105) เขียน
-- 7 คอลัมน์ (summary_shop_sent_at/by, summary_sent_at/by, pending_documents, documents_confirmed_at/by)
-- บนเคส approved — ไม่มีตัวไหนอยู่ใน allow-list ของ Guard B เลย ผลคือ staff (ไม่ใช่แอดมิน) กดสรุปยอด
-- ถูก Guard B บล็อกทุกครั้งด้วยข้อความ "เคสนี้ตรวจผ่านแล้ว แก้ไขไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน" —
-- deadlock ระหว่าง 2 guard ที่เพิ่มคนละรอบ (0150 ตั้งใจแก้ over-block ของ email_sent_at แต่ลืมเผื่อ
-- ฟีเจอร์ที่จะมาเพิ่มทีหลังทั้งหมด — Guard D เป็นตัวอย่างแรกที่ชน)
--
-- ตรวจเจอว่ากว้างกว่านั้นมาก: allow-list เดิมบล็อก "ทุกคอลัมน์อื่น" ของสัญญา approved ไม่ใช่แค่ summary —
-- ไล่โค้ด src/lib/db.ts จริงแล้วพบว่า Guard B เคยบล็อก (เงียบๆ ตั้งแต่ 0143 launch, กระทบเฉพาะสัญญา
-- post-cutoff ที่ approved แล้ว ซึ่งตอนนี้ยังมีจำนวนน้อยแต่จะโตขึ้นทุกวัน):
--   - rejectSummaryContract / sendSummaryBackToStaff / clearNeedsFix (บัญชีตีกลับเคส)
--   - mark_summary_accounting_sent RPC (ส่งบัญชี รอบ 2)
--   - markDocsReceived / markBoxReceived / setDocsIncomplete (doc tracking)
--   - setContractFlags ทั้งก้อน (DNC/ทนาย/ข้อโต้แย้ง/Case Online/กล่องเครื่อง — compliance + ops flags)
--   - closeCase (ปิดเคสในคิวโทร), setCreditHistoryFound
--   - restructureContract RPC (ขยายเวลา — เขียน due_day/monthly_payment/finance_amount/term_months;
--     ปุ่ม "ขยายระยะเวลา" ใน ContractDetail.tsx เปิดให้ staff กดได้ปกติ ไม่เกี่ยวกับ review_status เลย)
--   - settle_contract_early / close_contract_early_preserve_schedule / undo_close_contract_early /
--     close_returned_contract / autoclose_on_full_payment (flip contracts.status — เขียนผ่าน RPC
--     SECURITY DEFINER แต่ trigger ยังทำงานตาม auth.uid() ของผู้เรียกอยู่ดี ไม่ได้ยกเว้นอัตโนมัติ)
--
-- เจตนาจริงของ Guard B (แบม ยืนยันจาก canStaffEdit() ใน src/lib/review.ts + spec-review-flow.md §4.1):
-- "ห้ามแก้เนื้อหาสัญญาที่คุณเตยตรวจไปแล้ว" = เฉพาะฟิลด์ในแผงตรวจ (src/lib/reviewFields.ts, buildReviewFields)
-- ที่ตรงกับฟอร์ม "แก้ไขสัญญา" เต็มรูป (toUpdate() ใน db.ts, หน้า /edit/:id) เท่านั้น — ไม่ใช่ฟิลด์ workflow
-- หลังตรวจ (สรุปยอด/ส่งเมล/เอกสาร/มอบหมาย/สถานะการชำระ/ขยายเวลา/ปิดสัญญา) ที่ยังต้องทำงานต่อเนื่องได้
-- ตลอดอายุสัญญาแม้ approved ไปแล้ว (approved ไม่ใช่ "จบเคส" แค่ "ข้อมูลตอนเปิดสัญญาถูกต้องแล้ว")
--
-- ทางแก้: กลับข้าง Guard B จาก allow-list (จำเฉพาะที่ "แก้ได้") เป็น deny-list (จำเฉพาะที่ "แก้ไม่ได้")
-- และเทียบทีละคอลัมน์ตรงๆ (new.<col> is distinct from old.<col>) แทนการหัก to_jsonb — ผลพลอยได้:
-- ไม่มีทางชนบั๊ก "คอลัมน์ generated เป็น NULL ใน BEFORE trigger" (0150) อีกต่อไปเลย เพราะ deny-list
-- enumerate เฉพาะคอลัมน์จริงที่ไม่ใช่ generated เท่านั้น — ไม่ต้องพึ่ง contracts_generated_columns()
-- ใน Guard B อีก (ฟังก์ชันนั้นยังอยู่เผื่อ guard อื่นในอนาคตต้องใช้ ไม่ได้ลบ)
--
-- ⚠️⚠️ เพิ่มคอลัมน์ "เนื้อหาสัญญา" ใหม่บน public.contracts ในอนาคต (ฟิลด์ที่โชว์ในแผงตรวจ/กรอกตอนเปิดสัญญา
-- และไม่มี workflow อื่นเขียนทับหลังอนุมัติ) ต้องมาเพิ่มใน deny-list ของ Guard B ด้วย ไม่ทำ = fail-open
-- (fail-open นี้ตั้งใจยอมรับความเสี่ยง เทียบกับ fail-closed ของเวอร์ชันก่อนที่บล็อกงานจริงกว้างเกินไป —
-- คุณเตยเคาะแล้วว่าเสี่ยงน้อยกว่าเงินร้านค้างเพราะบล็อกงาน) เช็ค column list ปัจจุบันด้วย:
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'contracts' order by column_name;
--
-- Additive/idempotent — create or replace function (คงชื่อ/trigger เดิม), drop trigger if exists ก่อนสร้างใหม่
-- ไม่แตะตาราง/คอลัมน์/ข้อมูล/RPC อื่นใดๆ (ไม่ต้องแตะ contract_review_log constraint หรือ
-- force_mark_summary_shop_sent — ทั้งคู่ทำไว้ครบแล้วใน 0151 ไม่เกี่ยวกับ Guard B)

-- ============================================================================
-- contracts_review_guard() — Guard A + Guard C + Guard D copy verbatim จาก 0151 (ห้ามแก้แม้ตัวอักษรเดียว)
-- Guard B (แก้เฉพาะจุดนี้): allow-list -> deny-list ตาม field table ในคำอธิบายท้ายไฟล์
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

  -- Guard B (0153 — deny-list แทน allow-list เดิม): เคส approved แล้ว — staff (ไม่ใช่แอดมิน) แก้ "เนื้อหาสัญญา"
  -- ที่อยู่ในแผงตรวจ + ฟอร์มแก้ไขสัญญาเต็มรูป (toUpdate() ใน db.ts) ไม่ได้ ส่วนคอลัมน์อื่นทั้งหมด (workflow/
  -- lifecycle/compliance/servicing) ไม่ถูกเทียบเลย = แก้ได้ปกติไม่ว่า review_status จะเป็นอะไร
  -- รายละเอียด "ทำไมล็อก/ทำไมปล่อย" รายฟิลด์ — ดู comment หัวไฟล์นี้ + ตารางในข้อความที่ส่งคุณเตย/ครีม
  -- (สรุปสั้น: ล็อกเฉพาะตัวตนลูกค้า/เครื่อง/ราคาตั้งต้น/ร้าน/โปร/ผู้ทำรายการที่กรอกตอนเปิดสัญญา — ปล่อย
  -- ทุกอย่างที่เป็นการทำงานต่อเนื่องหลังอนุมัติ รวมถึง finance_amount/monthly_payment/term_months/due_day
  -- ที่ restructure_contract (ปุ่ม "ขยายระยะเวลา") ต้องแก้ได้แม้ approved แล้ว)
  if old.review_status = 'approved' and not public.is_admin() then
    if new.contract_no        is distinct from old.contract_no
    or new.inv_no              is distinct from old.inv_no
    or new.sn                  is distinct from old.sn
    or new.imei                is distinct from old.imei
    or new.customer_name       is distinct from old.customer_name
    or new.national_id         is distinct from old.national_id
    or new.phone               is distinct from old.phone
    or new.phone_alt1          is distinct from old.phone_alt1
    or new.phone_alt2          is distinct from old.phone_alt2
    or new.facebook_link       is distinct from old.facebook_link
    or new.birth_year          is distinct from old.birth_year
    or new.occupation          is distinct from old.occupation
    or new.occupation_proof    is distinct from old.occupation_proof
    or new.shop_id             is distinct from old.shop_id
    or new.model               is distinct from old.model
    or new.storage             is distinct from old.storage
    or new.condition           is distinct from old.condition
    or new.origin              is distinct from old.origin
    or new.device_price        is distinct from old.device_price
    or new.color               is distinct from old.color
    or new.down_percent        is distinct from old.down_percent
    or new.commission_percent  is distinct from old.commission_percent
    or new.doc_fee             is distinct from old.doc_fee
    or new.has_promotion       is distinct from old.has_promotion
    or new.promotion           is distinct from old.promotion
    or new.promotion_detail    is distinct from old.promotion_detail
    or new.transaction_date    is distinct from old.transaction_date
    or new.operator            is distinct from old.operator
    or new.notes               is distinct from old.notes
    or new.credit_history_found is distinct from old.credit_history_found
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
  --     force_mark_summary_shop_sent (SECTION 3 ของ 0151) ซึ่งตั้ง GUC ธุรกรรม-เดียว 'app.force_summary_rpc'
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
  '(0143+0149+0150+0151+0153) BEFORE UPDATE guard บน contracts: Guard A กัน review_status/review_updated_at/review_updated_by ถูกเขียนตรงนอก RPC 0142; Guard B (0153, deny-list) กัน staff แก้เฉพาะคอลัมน์เนื้อหาสัญญา (ตัวตนลูกค้า/เครื่อง/ราคาตั้งต้น/ร้าน/โปร/ผู้ทำรายการ/credit_history_found — ตรงกับ toUpdate() ใน db.ts) บนสัญญา approved แล้ว ปล่อยทุกคอลัมน์ workflow/lifecycle อื่น (รวม finance_amount/monthly_payment/term_months/due_day ที่ restructure_contract ต้องแก้ได้) ให้แก้ได้ปกติ; Guard C (0149) กัน stamp/re-stamp email_sent_at บนสัญญา post-cutoff ที่ยังไม่ approved; Guard D (0151) กัน stamp summary_shop_sent_at บนสัญญา post-cutoff ที่ยังไม่ approved — ทางออกเดียวคือ RPC force_mark_summary_shop_sent — ยกเว้น service_role ทั้งหมด และยกเว้นทุก request ที่ auth.uid() เป็น null (owner/MCP/cron/Edge)';

-- ตัวนี้แก้ function เดิม ไม่ใช่สร้าง trigger ใหม่ — แต่ drop/create ซ้ำเพื่อความชัดเจน+idempotent
-- (contracts มี BEFORE UPDATE trigger ตัวเดียวชื่อ contracts_review_guard เหมือนเดิมหลัง apply)
drop trigger if exists contracts_review_guard on public.contracts;
create trigger contracts_review_guard
  before update on public.contracts
  for each row execute function public.contracts_review_guard();

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ครีมมีชุดทดสอบเต็มแยกไว้ให้แล้ว (DO $$ ... rollback) — ใช้ query สั้นด้านล่างเป็น sanity เร็วๆ ก่อน
-- ============================================================================

-- a) trigger ยังมีตัวเดียวบน contracts (ไม่ได้เพิ่ม trigger ที่สอง):
-- select count(*) from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = 'contracts_review_guard';
-- expected: 1

-- b) contracts_generated_columns() ยังคืน 3 เหมือนเดิม (0150 ไม่ถูกแตะ แม้ Guard B ใหม่ไม่เรียกใช้แล้ว):
-- select public.contracts_generated_columns();
-- expected: {after_down,commission_amount,net_transfer}

-- c) force_mark_summary_shop_sent (0151) ยังอยู่ครบ ไม่ถูกแตะ:
-- select has_function_privilege('authenticated', 'public.force_mark_summary_shop_sent(uuid, text, date)', 'EXECUTE');
-- expected: true

-- d) contract_review_log action constraint ยังกว้างเท่า 0151 (ไม่ถูกแตะรอบนี้):
-- select pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.contract_review_log'::regclass and conname = 'contract_review_log_action_check';
-- expected: check (action in ('submit','approve','reject','cancel_approval','force_summary_shop_sent'))
