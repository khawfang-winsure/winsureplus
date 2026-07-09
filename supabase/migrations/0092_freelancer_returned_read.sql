-- 0092: แก้ RLS ให้ทีมติดตามหนี้ (freelancer) มองเห็นสัญญา "คืนเครื่องแล้วแต่ยังค้างเงิน" (status='returned')
--
-- ROOT CAUSE (verify แล้ว): เดิมนโยบาย contracts_read/installments_read (0018) เงื่อนไข freelancer
--   อนุญาตเฉพาะ status = 'active' เท่านั้น. migration 0090 แก้ v_contract_status ให้คำนวณ
--   bucket/grade/overdue_amount ของเคส returned ถูกต้องแล้ว (77 เคสผ่านเงื่อนไข bucket<>'normal'
--   AND grade IS NOT NULL AND overdue_amount>0 เมื่อ query ด้วยสิทธิ์สูง/service_role) — แต่
--   v_contract_status ประกาศ security_invoker=on (รัน RLS ของผู้เรียกจริง ไม่ใช่ view owner)
--   ดังนั้นเมื่อ freelancer เรียก getFreelancerQueue() จริง RLS ชั้น base table (contracts/
--   installments) กรองแถว status='returned' ทิ้งไปก่อนที่ CASE logic ของ view จะรันด้วยซ้ำ
--   → v_contract_status คืน 0 แถวสำหรับเคส returned ทุกเคส เฉพาะ session freelancer
--   (admin/staff ไม่โดน เพราะมี clause is_admin()/role='staff' บายพาส RLS ของ 2 นโยบายนี้อยู่แล้ว)
--   → เคสคืนเครื่องยังค้างยอด 77 เคส ไม่เคยโผล่ในคิวทีมโทร (แท็บ "คืนเครื่อง" ของ FreelancerWorkspace)
--
-- แก้: ขยายเงื่อนไข status ในนโยบาย freelancer clause ของ contracts_read + installments_read
--   จาก `status = 'active'` เป็น `status in ('active','returned')` — grade scope
--   (freelancer_has_grade) ยังคงบังคับเหมือนเดิมทุกจุด ไม่เปิดกว้างเกินความจำเป็น
--   ปิดจบแล้ว (closed/returned_closed/online) ยังไม่อยู่ใน status list ที่อนุญาต — ไม่โผล่เหมือนเดิม
--
-- ส่วนเสริม: extra_charges_read (0032) เดิมมีแค่ admin/staff เท่านั้น ไม่มี clause freelancer เลย
--   getFreelancerQueue คำนวณ returnClosingAmount (outstandingAfterReturn) ต้องอ่าน extra_charges
--   ด้วย (ค่าซ่อม/ค่าใช้จ่ายอื่น) — ถ้าไม่เพิ่ม freelancer จะเห็นยอดปิดเคสคืนเครื่องขาดค่าซ่อม/extras
--   เพิ่ม clause freelancer แบบ grade-scoped (active+returned) ให้สอดคล้องกับ 2 policy ข้างบน
--
-- ไม่กระทบ: admin/staff (บายพาสทุก policy อยู่แล้วด้วย is_admin()/role='staff')
-- ไม่กระทบ: เคส closed/returned_closed/online — ปิดจบแล้ว ไม่อยู่ใน status list ที่อนุญาต

-- ----- contracts_read: เพิ่ม 'returned' ในเงื่อนไข freelancer (เดิม status='active' เท่านั้น) -----
drop policy if exists contracts_read on contracts;
create policy contracts_read on contracts for select to authenticated using (
  is_admin()
  OR ((select role from profiles where id = auth.uid()) = 'staff')
  OR (
    is_freelancer()
    AND status in ('active', 'returned')
    AND current_grade is not null
    AND freelancer_has_grade(current_grade)
  )
);

-- ----- installments_read: เพิ่ม 'returned' ในเงื่อนไข freelancer (เดิม c.status='active' เท่านั้น) -----
drop policy if exists installments_read on installments;
create policy installments_read on installments for select to authenticated using (
  is_admin()
  OR ((select role from profiles where id = auth.uid()) = 'staff')
  OR exists (
    select 1 from contracts c
    where c.id = installments.contract_id
      and c.status in ('active', 'returned')
      and c.current_grade is not null
      and is_freelancer()
      and freelancer_has_grade(c.current_grade)
  )
);

-- ----- extra_charges_read: เพิ่ม freelancer (grade-scoped, active+returned) — เดิมมีแค่ admin/staff -----
drop policy if exists extra_charges_read on public.extra_charges;
create policy extra_charges_read on public.extra_charges
  for select to authenticated
  using (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
    or (
      is_freelancer()
      and exists (
        select 1 from contracts c
        where c.id = extra_charges.contract_id
          and c.status in ('active', 'returned')
          and c.current_grade is not null
          and freelancer_has_grade(c.current_grade)
      )
    )
  );

-- ============================================================================
-- Verify checklist สำหรับครีม รันหลัง apply (ผ่าน MCP)
-- ============================================================================

-- 1) policy ครบชื่อเดิม ไม่เพิ่ม/ลด (contracts_read, installments_read, extra_charges_read):
-- SELECT policyname, tablename FROM pg_policies
--   WHERE tablename IN ('contracts','installments','extra_charges')
--   ORDER BY tablename, policyname;

-- 2) baseline สิทธิ์สูง (ไม่ผ่าน RLS freelancer — ยืนยันตัวเลข 77 ยังนิ่งก่อน/หลัง apply):
-- SELECT count(*) FROM public.v_contract_status
--   WHERE status = 'returned' AND bucket <> 'normal' AND grade IS NOT NULL AND overdue_amount > 0;
-- expected: ~77 (ไม่เปลี่ยนจาก migration นี้ — migration นี้แก้แค่ว่า "ใครมองเห็นแถว" ไม่ใช่ตัวเลข view)

-- 3) smoke จริง (สำคัญที่สุด — ต้อง login เป็น freelancer จริงใน browser แล้วเรียก getFreelancerQueue()
--    หรือดู network tab หน้า /queue): เคส returned ในเกรดของ freelancer คนนั้นต้องโผล่ในคิวแท็บ "คืนเครื่อง"
--    ตัวเลข #2 ที่ query ผ่าน service_role ไม่ยืนยันผลของ fix นี้ได้ — RLS เป็นเรื่องของ "ผู้เรียก" เท่านั้น

-- 4) กันเผลอเปิดกว้างเกิน — closed/returned_closed/online ต้องยังมองไม่เห็น (login freelancer):
-- SELECT count(*) FROM public.v_contract_status WHERE status IN ('closed','returned_closed','online');
-- expected (จาก session freelancer): 0 แถว (RLS ยัง block เพราะไม่อยู่ใน status list ที่อนุญาต)
