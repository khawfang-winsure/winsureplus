-- ============================================================================
-- SEED ทดสอบ — สร้างข้อมูลจำลอง ~52 เคส + ร้านทดสอบ 4 ร้าน
-- ⚠️ นี่คือ "ข้อมูลทดสอบ" ไม่ใช่ schema — รันใน SQL Editor เพื่อเทสรายงาน
-- ทุกแถวขึ้นต้น SEED / TESTSEED → ลบทิ้งทีหลังได้ (ดูคำสั่งลบท้ายไฟล์)
--
-- จุดประสงค์: ให้เห็นข้อมูลจริงในหน้า ลูกค้าล่าช้า/หนี้เสีย (ทุกกลุ่มวัน) + รายงานค่าคอม
-- หลักการ: ใส่ "วันที่ทำรายการย้อนหลัง" → trigger สร้างงวด → งวดแรกตกค้าง = ล่าช้าเอง
--   (ไม่ต้อง mark จ่าย ก็กลายเป็นหนี้เสียตามจำนวนวันที่ย้อน)
-- ต้องมี: รัน 0001–0009 ครบ + มีพนักงาน (profiles) อย่างน้อย 1 คน
-- ============================================================================

do $$
declare
  emps uuid[];
  e1 uuid; e2 uuid; e3 uuid;
  sh_a uuid; sh_b uuid; sh_c uuid; sh_d uuid;
  shop uuid;
  rec  uuid;
  i int;
begin
  -- พนักงานสูงสุด 3 คน (ถ้ามีน้อยกว่า ใช้ซ้ำ)
  select array_agg(id) into emps from (select id from profiles order by created_at limit 3) q;
  if emps is null then
    raise exception 'ไม่มีพนักงานใน profiles — ต้องมีอย่างน้อย 1 คนก่อน seed';
  end if;
  e1 := emps[1];
  e2 := coalesce(emps[2], e1);
  e3 := coalesce(emps[3], e1);

  -- ร้านทดสอบ 4 ร้าน (3 ร้านมีผู้หา / 1 ร้านไม่มี)
  insert into shops (code, name, active, recruited_by, recruited_at)
    values ('SEEDA', 'TESTSEED ร้าน A (ลบได้)', true, e1, date '2026-06-03') returning id into sh_a;
  insert into shops (code, name, active, recruited_by, recruited_at)
    values ('SEEDB', 'TESTSEED ร้าน B (ลบได้)', true, e1, date '2026-06-08') returning id into sh_b;
  insert into shops (code, name, active, recruited_by, recruited_at)
    values ('SEEDC', 'TESTSEED ร้าน C (ลบได้)', true, e2, date '2026-03-05') returning id into sh_c;
  insert into shops (code, name, active, recruited_by, recruited_at)
    values ('SEEDD', 'TESTSEED ร้าน D ไม่มีผู้หา (ลบได้)', true, null, null) returning id into sh_d;

  -- 50 เคส: วันที่ทำรายการ = 8 มิ.ย. ลบไป i*4 วัน (i ยิ่งมาก ยิ่งย้อนไกล = ยิ่งล่าช้ามาก)
  for i in 1..50 loop
    shop := case (i % 4) when 0 then sh_a when 1 then sh_b when 2 then sh_c else sh_d end;
    rec  := case (i % 3) when 0 then e1 when 1 then e2 else e3 end;
    insert into contracts (
      contract_no, customer_name, shop_id, recorded_by,
      device_price, down_percent, commission_percent, doc_fee,
      monthly_payment, term_months, due_day,
      status, transaction_date, operator
    ) values (
      'SEED-' || lpad(i::text, 3, '0'),
      'ลูกค้าทดสอบ ' || i,
      shop, rec,
      20000, 20, 10, 100,
      1800, 6, 5,
      'active',
      (date '2026-06-08' - make_interval(days => i * 4))::date,
      'seed'
    );
  end loop;

  -- จ่ายตรงเวลา (เคสดี) — งวด 1 จ่ายตรงกำหนด (ไม่โดนหักค่าคอม)
  update installments i set paid_at = (i.due_date + time '10:00')::timestamptz, status = 'paid'
  from contracts c
  where i.contract_id = c.id and i.installment_no = 1
    and c.contract_no in ('SEED-003', 'SEED-004', 'SEED-005', 'SEED-006');

  -- จ่ายช้าเกิน 30 วัน (เทสหักค่าคอมจากประวัติจ่ายช้า) — SEED-009, SEED-010
  update installments i set paid_at = (i.due_date + interval '40 days')::timestamptz, status = 'paid'
  from contracts c
  where i.contract_id = c.id and i.installment_no = 1
    and c.contract_no in ('SEED-009', 'SEED-010');

  -- คืนเครื่อง "หลังล่าช้าเกิน 30 วัน" (ต้องโดนหัก) — SEED-040 (ย้อนไกล = ล่าช้ามาก)
  update contracts set status = 'returned' where contract_no = 'SEED-040';
  insert into device_returns (contract_id, case_no, last_installment_paid, penalty_paid, repair_fee, checked_at)
    select id, 1, false, false, 0, now() from contracts where contract_no = 'SEED-040';

  -- คืนเครื่อง "ก่อนล่าช้า 30 วัน" (ไม่โดนหัก) — SEED-001 (เพิ่งทำรายการ งวดแรกยังไม่ถึงกำหนด)
  update contracts set status = 'returned' where contract_no = 'SEED-001';
  insert into device_returns (contract_id, case_no, last_installment_paid, penalty_paid, repair_fee, checked_at)
    select id, 2, true, true, 0, now() from contracts where contract_no = 'SEED-001';

  raise notice 'SEED เสร็จ: 4 ร้าน + 50 เคส (SEED-001..050)';
end $$;

-- ============================================================================
-- ลบข้อมูลทดสอบทั้งหมด (รันเมื่อเทสเสร็จ) — เอาเครื่องหมาย -- ออกก่อนรัน
-- ----------------------------------------------------------------------------
-- delete from contracts where contract_no like 'SEED-%';   -- งวด/คืนเครื่อง ลบตาม (on delete cascade)
-- delete from shops where code like 'SEED%';
-- ============================================================================
