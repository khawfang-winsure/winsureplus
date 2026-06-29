-- กันคีย์เลขใบ PJ (inv_no) ซ้ำ: normalize + unique index
-- ตัดช่องว่างหัวท้ายของ inv_no ที่อาจหลงเหลือ (idempotent)
update public.contracts set inv_no = trim(inv_no)
 where inv_no is not null and inv_no <> trim(inv_no);

-- unique index (อนุญาตหลาย NULL ได้ตามปกติ Postgres — สัญญาที่ยังไม่มีเลขใบไม่ชน)
create unique index if not exists contracts_inv_no_uniq on public.contracts (inv_no);
