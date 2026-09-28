-- 0167: ค้นบัญชีดำ PJ อัตโนมัติ + สัญญาณเตือนทุจริตชั้นที่ 1 (Wave 3 + addendum, ครีม 2026-09-28)
--
-- คำตัดสินเจ้าของ 2026-09-28 (ดู scratchpad pj-blacklist-contract.md + ADDENDUM ท้ายไฟล์เดียวกัน):
--   1) เพิ่มการค้นบัญชีดำ PJ อัตโนมัติตอนร้านส่งคำขอเช็คเครดิต (แทนที่ staff ค้นมือ — blacklistseller
--      ยังอยู่เป็นปุ่มมือเหมือนเดิม รอ API เสียเงินภายหลัง)
--   2) เพิ่มชั้นตรวจทุจริตเบื้องต้น: บัตรเพิ่งออกใหม่ (<180 วัน) + สัญญาณระบบ (ชื่อเปลี่ยน/ไฟล์ซ้ำ/FB ซ้ำ/
--      PDF ถูกแก้ไข) — ทุกอย่าง "best-effort, เตือนเท่านั้น" ไม่ fail อัตโนมัติเด็ดขาด (เกณฑ์ mandatory
--      เดิมของ 0164 ยังทำงานเหมือนเดิมทุกอย่าง — ไฟล์นี้เพิ่มแต่ signal ใหม่ ไม่แตะเกณฑ์เดิม)
--   ทั้งสองส่วนพับรวมเป็น migration เดียว (0167) ตามที่สั่ง ไม่แยก 0168
--
-- Additive ทั้งหมด — ไม่แตะ/ลบตาราง คอลัมน์ policy หรือฟังก์ชันเดิมของ 0164/0165/0166 เลย
--
-- ⚠️ ยังไม่ apply — ครีมเป็นคน apply ผ่าน MCP หลังทีมตรวจงาน Wave 3 นี้แล้วเท่านั้น
--
-- ============================================================================
-- SECTION 1: credit_checks — คอลัมน์ใหม่ (PJ blacklist + anti-fraud)
-- ============================================================================

alter table public.credit_checks
  add column if not exists imei text,
  add column if not exists pj_blacklist_status text not null default 'not_checked'
    check (pj_blacklist_status in ('not_checked', 'clear', 'found', 'error')),
  add column if not exists pj_blacklist_hits jsonb not null default '[]'::jsonb,
  add column if not exists pj_blacklist_checked_at timestamptz,
  add column if not exists pj_blacklist_error text,
  add column if not exists id_issue_date date,
  add column if not exists fraud_flags jsonb not null default '[]'::jsonb;

comment on column public.credit_checks.imei is
  '(0167) IMEI เครื่อง (ถ้าร้านกรอก) — ใช้เป็นคีย์ค้นที่ 2 ในบัญชีดำ PJ นอกจากเลขบัตร ปชช. ไม่บังคับ';
comment on column public.credit_checks.pj_blacklist_status is
  '(0167) ผลค้นบัญชีดำ PJ อัตโนมัติตอน submit (+ staff กด "ค้นซ้ำ" ได้ทาง staff_pj_recheck): not_checked=ยังไม่ค้น (แถวเก่าก่อน 0167) / clear=ค้นแล้วไม่เจอ / found=เจอ (ดู pj_blacklist_hits) / error=ค้นไม่สำเร็จ (timeout/login พัง ฯลฯ — ไม่บล็อก submit)';
comment on column public.credit_checks.pj_blacklist_hits is
  '(0167) รายการที่เจอจากบัญชีดำ PJ — staff เห็นเต็ม (invoice/ร้าน/ยอดค้าง) ร้านที่ส่งคำขอ "ห้ามเห็นเด็ดขาด" (PDPA — ร้านอื่นเจ้าของประวัติไม่ได้ยินยอมให้ร้านที่ส่งคำขอเห็น) แต่ละ item shape: {invoice_no, status_label, customer_name, shop_name, shop_contact, brand, model, imei_last4, down_payment_date, next_due_date, installments_total, installments_paid, installments_overdue, matched_by: national_id|imei}';
comment on column public.credit_checks.pj_blacklist_error is
  '(0167) ข้อความ error สั้นๆ ตอนค้น PJ ไม่สำเร็จ (ไม่มี PII/credential ปน) — ใช้ debug เฉยๆ ไม่โชว์ร้าน';
comment on column public.credit_checks.id_issue_date is
  '(0167 addendum) วันออกบัตร ปชช. (ไทยเป็นหลัก ต่างชาติไม่บังคับ) — ใช้กับกฎ "บัตรเพิ่งออกใหม่ <180 วัน" (CARD_RECENTLY_ISSUED)';
comment on column public.credit_checks.fraud_flags is
  '(0167 addendum) สัญญาณเตือนทุจริตที่ระบบคำนวณได้ตอน submit (best-effort, ไม่บล็อก submit) — array of {code, severity: warn|high, detail_staff} โค้ดที่มี ณ ตอนนี้: NAME_CHANGED, DUP_FILE, FB_SHARED, PDF_EDITED, PDF_UNREADABLE — staff เห็นรายละเอียดเต็ม ร้าน "ห้ามรู้" ว่าสัญญาณคืออะไร (engine ส่งแค่ reason FRAUD_SIGNAL ทั่วไปให้ร้าน)';

-- ============================================================================
-- SECTION 2: credit_check_files — เพิ่ม kind 'thaid_name_history' (ภาพประวัติเปลี่ยนชื่อจากแอป ThaID)
-- constraint เดิมเป็น inline column check ตอนสร้างตาราง (0164) → ชื่อ default ของ Postgres คือ
-- <table>_<column>_check — drop if exists กันพลาดชื่อ แล้วสร้างใหม่ครอบ kind เดิมทั้งหมด + ตัวใหม่
-- ============================================================================

alter table public.credit_check_files
  drop constraint if exists credit_check_files_kind_check;

alter table public.credit_check_files
  add constraint credit_check_files_kind_check
  check (kind in (
    'payslip', 'statement', 'work_photo', 'facebook_screenshot', 'id_card', 'thaid_name_history', 'other'
  ));

comment on column public.credit_check_files.kind is
  '(0164, ขยาย 0167) ชนิดไฟล์แนบ — thaid_name_history (0167 addendum) = ภาพประวัติเปลี่ยนชื่อ-สกุลจากแอป ThaID ของลูกค้า (ร้านแนบเพิ่มเมื่อบัตรเพิ่งออกใหม่ <180 วัน ตามคำแนะนำในฟอร์ม)';

-- (แก้ตามรีวิวติ๊ก [YELLOW] #2) r2_etag — ตัวตนไฟล์ที่ "R2 ยืนยันเองหลังอัปโหลดจริง" ไม่ใช่ sha256 ที่ client
-- แจ้งมาเฉยๆ (เชื่อ 100% ไม่ได้ — ร้านฝั่ง client แก้ payload เองได้ก่อนส่ง submit) ใช้เป็นตัวตนหลักของ
-- DUP_FILE แทน — คอลัมน์ sha256 เดิมยังอยู่เหมือนเดิม (เก็บไว้เป็น fallback เมื่อ r2_etag ไม่น่าเชื่อถือ
-- เช่น multipart upload ที่ ETag ไม่ใช่ MD5 ตรงๆ — ดู fraudSignals.ts isReliableEtag)
alter table public.credit_check_files
  add column if not exists r2_etag text;

comment on column public.credit_check_files.r2_etag is
  '(0167, แก้ตามรีวิวติ๊ก) ETag จริงจาก R2 ที่ Edge Function ไปขอ (Range GET 1 byte) ยืนยันเองหลังอัปโหลด —
   PUT ธรรมดา (ไม่ใช่ multipart) ETag = MD5 hex ของเนื้อไฟล์ตรงๆ ใช้เป็นตัวตนหลักของ DUP_FILE แทน sha256 ที่
   client แจ้งเอง — null หรือรูปแบบ multipart ("<hex>-<partcount>") ให้ fallback ไปเทียบ sha256 แทน';

-- ============================================================================
-- SECTION 3: index รองรับการค้นหา (DUP_FILE / FB_SHARED)
--
-- หมายเหตุความจริงใจ (ดูรายงานที่ส่งพร้อม migration นี้): ตอน Wave 3 นี้ implementation จริงของ FB_SHARED
-- ใน Edge Function ยังไม่ได้ query ด้วย `lower(facebook_url) = ...` ตรงๆ ผ่าน index นี้ — ใช้วิธีดึงแถว
-- แบบ bounded (limit 500, order by created_at desc) มา normalize+เทียบฝั่ง JS แทน เพราะ scale ตอนนี้
-- (pilot 2 ร้าน) เล็กมาก sequential scan เร็วพอ และเลี่ยงการเพิ่ม SECURITY DEFINER RPC ใหม่ (พื้นที่เสี่ยง
-- เพิ่มโดยไม่จำเป็น) ใส่ index นี้ไว้ตามที่ contract ขอ เผื่ออนาคตย้ายไป query แบบ `lower(facebook_url)=x`
-- ตรงๆ (ผ่าน RPC) เมื่อจำนวนแถวโตขึ้นจนต้อง optimize จริง — ไม่ใช่ index ที่ "ใช้งานจริง" ณ ตอนนี้ แต่ไม่มี
-- ผลเสียอะไรที่จะมีไว้ก่อน (constant overhead เล็กน้อยตอน insert/update ตารางนี้)
-- ============================================================================

create index if not exists credit_check_files_sha256_idx
  on public.credit_check_files (sha256)
  where sha256 is not null;

-- (0167, แก้ตามรีวิวติ๊ก [YELLOW] #2) index หลักที่ DUP_FILE ใช้จริง (r2_etag เชื่อถือได้กว่า sha256 —
-- ดูคอมเมนต์คอลัมน์ด้านบน) sha256 index ข้างบนยังคงไว้เป็น fallback path เท่านั้น
create index if not exists credit_check_files_r2_etag_idx
  on public.credit_check_files (r2_etag)
  where r2_etag is not null;

create index if not exists credit_checks_facebook_url_lower_idx
  on public.credit_checks (lower(facebook_url))
  where facebook_url is not null;

-- ============================================================================
-- SECTION 4: v_credit_check_queue — เพิ่ม pj_blacklist_status + pj_blacklist_hit_count + fraud_flag_count
-- (ไม่เพิ่มรายละเอียด hits/fraud_flags เต็มในคิว — ดูเต็มที่ credit_checks ตรงๆ ในหน้ารายละเอียดเท่านั้น)
-- security_invoker=on เหมือนเดิม (0164) — RLS ของ credit_checks/shops (ผู้เรียกจริง) มีผลตามปกติ
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
  round(extract(epoch from (coalesce(cc.decided_at, now()) - cc.created_at)) / 60.0, 1) as minutes_to_decision,
  cc.pj_blacklist_status,
  coalesce(jsonb_array_length(cc.pj_blacklist_hits), 0) as pj_blacklist_hit_count,
  coalesce(jsonb_array_length(cc.fraud_flags), 0) as fraud_flag_count
from public.credit_checks cc
join public.shops s on s.id = cc.shop_id;

comment on view public.v_credit_check_queue is
  '(0164, ขยาย 0167) หน้าคิว staff/admin ตรวจคำขอเช็คเครดิต — national_id มาสก์เหลือ 4 ตัวท้าย, pj_blacklist_hit_count/fraud_flag_count = แค่จำนวน (รายละเอียดเต็มดูที่ credit_checks.pj_blacklist_hits/fraud_flags ตรงๆ ในหน้ารายละเอียด)';

-- defense-in-depth: restate grant หลัง create or replace (ACL คงอยู่จริงเพราะไม่เปลี่ยน/ลบคอลัมน์เดิม
-- แค่เพิ่มคอลัมน์ต่อท้าย — restate ซ้ำตาม house style เผื่อมีใคร manual grant ผิดไว้ก่อนหน้า)
grant select on public.v_credit_check_queue to authenticated;
grant select on public.v_credit_check_queue to service_role;

-- ============================================================================
-- SECTION 5: purge_expired_credit_checks — ไม่ต้องแก้โค้ด (ตามที่ตรวจสอบแล้ว)
-- ฟังก์ชันเดิม (0164 SECTION 10) ลบทั้งแถว credit_checks เมื่อหมดอายุ/ไม่ผูกสัญญา — คอลัมน์ใหม่ทั้งหมดใน
-- ไฟล์นี้ (imei, pj_blacklist_*, id_issue_date, fraud_flags) ถูกลบไปพร้อมแถวโดยอัตโนมัติอยู่แล้ว ไม่มี
-- ตารางลูกใหม่ที่ต้องลบแยก (credit_check_files ก็ถูกลบผ่าน on delete cascade เดิมเหมือนเดิมทุกอย่าง)
-- ============================================================================

-- ============================================================================
-- Verify checklist สำหรับครีม (รันหลัง apply — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================

-- 1) คอลัมน์ใหม่มีครบ + ค่า default ถูกต้อง:
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='credit_checks'
--   AND column_name IN ('imei','pj_blacklist_status','pj_blacklist_hits','pj_blacklist_checked_at',
--                        'pj_blacklist_error','id_issue_date','fraud_flags');

-- 2) constraint kind ใหม่ยอมรับ thaid_name_history:
-- INSERT INTO credit_check_files (credit_check_id, kind, r2_key) VALUES ('<test-id>', 'thaid_name_history', 'x');
-- -- ควร fail ด้วย FK (credit_check_id ไม่มีจริง) ไม่ใช่ check constraint — พิสูจน์ว่า kind ผ่าน

-- 3) service_role เข้าคอลัมน์ใหม่ได้ปกติ (grant ระดับตาราง ไม่ใช่ระดับคอลัมน์ — ควรผ่านอยู่แล้วจาก 0164):
-- SELECT has_table_privilege('service_role', 'public.credit_checks', 'UPDATE'); -- expected: true

-- 4) view คิวมีคอลัมน์ใหม่ครบ:
-- SELECT id, pj_blacklist_status, pj_blacklist_hit_count, fraud_flag_count FROM v_credit_check_queue LIMIT 5;

-- 5) anon ยังเป็นศูนย์เหมือนเดิม (ไม่มี grant ใหม่ให้ anon ในไฟล์นี้เลย):
-- SELECT has_table_privilege('anon', 'public.credit_checks', 'SELECT'); -- expected: false
