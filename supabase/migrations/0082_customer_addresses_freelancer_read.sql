-- 0082: ให้ผู้ติดตามหนี้ (freelancer) อ่านที่อยู่ลูกค้าได้เฉพาะเคสในเกรดที่ตัวเองดูแล
-- (additive SELECT policy — permissive OR กับ customer_addresses_staff เดิม, ไม่แตะ policy นั้น)

drop policy if exists customer_addresses_freelancer_read on public.customer_addresses;
create policy customer_addresses_freelancer_read on public.customer_addresses
  for select to authenticated
  using (
    exists (
      select 1 from public.contracts c
      where c.id = customer_addresses.contract_id
        and c.status = 'active'
        and c.current_grade is not null
        and is_freelancer()
        and freelancer_has_grade(c.current_grade)
    )
  );
