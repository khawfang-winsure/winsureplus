-- 0149: ปิดช่องโหว่ staff stamp email_sent_at ได้เองบนสัญญาที่ยังไม่ผ่านการตรวจของคุณเตย —
-- ตัวเดียวกับบั๊กที่ทำให้ 3 สัญญา (S00052PNQ001, S00026PNQ014, S00029PNQ037) ส่งเมลออกบริษัทจริง
-- พร้อมไฟล์แนบ 23 ไฟล์ โดยคุณเตยไม่เคยเห็น/อนุมัติ (พบ 2026-09-12, คุณเตยอนุมัติแก้แล้ว)
--
-- รากบั๊ก: review_status IS NULL กินความหมาย 2 อย่าง (1) สัญญาเก่าก่อน media_gate_from = ยกเว้นถาวร (ถูก)
-- (2) สัญญาใหม่ที่ยังไม่กด "ส่งให้คุณเตยตรวจ" = draft ที่ต้องบล็อก — แต่ทุกชั้น (Edge + DB) เดิมเช็คแค่
-- `review_status !== null` โดยไม่ดู created_at เทียบ media_gate_from เลย จึงปล่อย draft post-cutoff ผ่านหมด
--
-- 🔴 ห้ามแก้ย้อนหลัง 3 สัญญาที่หลุดไปแล้วในทุกรูปแบบ (รวม "จัดระเบียบ" review_status ให้เข้าโมเดลใหม่) —
-- คุณเตยรับทราบ/รับไปแล้ว การ backdate จะทำให้ contract_review_log (append-only ตาม 0142 SECTION 2) เป็น
-- ประวัติเท็จ
--
-- งานนี้แก้ 2 ชั้น (คู่กัน ต้อง deploy พร้อมกัน):
--   1) DB (ไฟล์นี้): เพิ่ม Guard C เข้า trigger เดียวเดิมของ contracts (public.contracts_review_guard, 0143)
--   2) Edge: supabase/functions/send-company-email/index.ts บรรทัด ~236-247 เปลี่ยนเงื่อนไข block เป็น
--      `isGated && reviewStatus !== 'approved'` (ของเดิม `reviewStatus !== null && ...`)
--
-- Additive/idempotent — create or replace function (คงชื่อ/trigger เดิม), drop trigger if exists ก่อนสร้างใหม่
-- ไม่แตะตาราง/คอลัมน์/ข้อมูลใดๆ

-- ============================================================================
-- Guard A + Guard B: copy verbatim จาก 0143_review_write_guard.sql บรรทัด 46-74 (ห้ามแก้แม้ตัวอักษรเดียว)
-- Guard C (ใหม่): เพิ่มต่อจาก Guard B, ก่อน return new — บล็อก stamp/re-stamp email_sent_at บนสัญญา
-- post-cutoff ที่ review_status ยังไม่ approved (ครอบทั้ง NULL->non-NULL และ re-stamp หลัง unapprove)
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

  -- Guard B: เคส approved แล้ว — staff (ไม่ใช่แอดมิน) แก้คอลัมน์อื่นของสัญญาไม่ได้
  -- ยกเว้น review_* (คุมโดย Guard A ไปแล้ว) และ email_sent_at/email_sent_by (canSendEmail ใน
  -- src/lib/review.ts ตั้งใจให้ staff กดปุ่ม "ส่งเมล/บันทึกว่าส่งเอง" ได้ตอน approved โดยไม่ต้องเป็นแอดมิน —
  -- ถ้าล็อกคอลัมน์นี้ด้วยจะพังฟีเจอร์ที่มีอยู่แล้วที่ WaitingEmail.tsx doMarkSent/markEmailSent)
  if old.review_status = 'approved' and not public.is_admin() then
    if (to_jsonb(new) - array[
          'review_status', 'review_updated_at', 'review_updated_by',
          'email_sent_at', 'email_sent_by'
        ]::text[])
       is distinct from
       (to_jsonb(old) - array[
          'review_status', 'review_updated_at', 'review_updated_by',
          'email_sent_at', 'email_sent_by'
        ]::text[])
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
  '(0143+0149) BEFORE UPDATE guard บน contracts: Guard A กัน review_status/review_updated_at/review_updated_by ถูกเขียนตรงนอก RPC 0142; Guard B กัน staff แก้คอลัมน์อื่นของสัญญา approved แล้ว ยกเว้น email_sent_at/by; Guard C (0149) กัน stamp/re-stamp email_sent_at บนสัญญา post-cutoff (media_gate_from) ที่ review_status ยังไม่ approved — ไม่ยกเว้น admin/override โดยตั้งใจ (ดู comment ในฟังก์ชัน) — ยกเว้น service_role ทั้งหมด และยกเว้นทุก request ที่ auth.uid() เป็น null (owner/MCP/cron/Edge)';

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

-- b) function ยังทำงาน — Guard A/B เดิมไม่พัง (ดูสคริปต์ทดสอบเจาะที่ครีมส่งมาให้แยก มี 5 เคส ก+ข+ค+ง+จ)

-- c) sanity: media_gate_from อ่านได้และ coalesce ตรงกับ 0142/Edge:
-- select value from public.app_settings where key = 'media_gate_from';
-- expected: '2026-09-09' (ถ้าไม่มีแถว coalesce ในฟังก์ชันจะใช้ '2026-09-09' เป็น default — ไม่ใช่ '' )
