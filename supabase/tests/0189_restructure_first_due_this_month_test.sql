-- ทดสอบ logic วันที่ของ 0189 รันได้บน DB จริงโดยไม่ต้อง apply (สร้างฟังก์ชันชั่วคราวใน pg_temp ด้วย EXECUTE)
-- จบด้วย raise exception เสมอ = rollback ไม่เขียนอะไรลง DB ผลอยู่ในข้อความ error ทุกบรรทัดควรเป็น PASS
-- ถ้า apply 0189 แล้ว เปลี่ยน pg_temp.rdd เป็น public.restructure_due_date ได้เพื่อทดสอบตัวจริง
do
$do$
declare out text := ''; r record; got date;
begin
  execute $sql$
    create function pg_temp.rdd(p_today date, p_due_day integer, p_i integer, p_last_paid_due date default null)
    returns date language sql immutable
    as $fn$
      select public.due_date_for((mi / 12)::int, (mi % 12 + 1)::int, p_due_day)
      from (
        select (extract(year from p_today)::int * 12 + extract(month from p_today)::int - 1)
          + greatest(
              case when public.due_date_for(extract(year from p_today)::int, extract(month from p_today)::int, p_due_day) > p_today
                   then 0 else 1 end,
              case when p_last_paid_due is null then 0
                   else (extract(year from p_last_paid_due)::int * 12 + extract(month from p_last_paid_due)::int)
                        - (extract(year from p_today)::int * 12 + extract(month from p_today)::int) + 1 end
            )
          + p_i - 1 as mi
      ) s
    $fn$
  $sql$;

  for r in select * from (values
    -- เคสเดิม (ไม่มีงวดจ่าย / งวดจ่ายเก่า)
    (date '2026-11-16', 30, 1, null::date, date '2026-11-30'),
    (date '2026-11-16', 30, 2, null::date, date '2026-12-30'),
    (date '2026-11-16', 30, 3, null::date, date '2027-01-30'),
    (date '2026-11-16', 30, 4, null::date, date '2027-02-28'),
    (date '2026-11-16', 30, 5, null::date, date '2027-03-30'),
    (date '2026-11-16', 30, 9, null::date, date '2027-07-30'),
    (date '2026-11-16', 16, 1, null::date, date '2026-12-16'),
    (date '2026-11-16',  5, 1, null::date, date '2026-12-05'),
    (date '2027-01-31', 31, 1, null::date, date '2027-02-28'),
    (date '2026-12-15', 31, 1, date '2026-09-01', date '2026-12-31'),
    (date '2026-12-15', 31, 2, date '2026-09-01', date '2027-01-31'),
    (date '2026-12-15', 10, 1, date '2026-09-01', date '2027-01-10'),
    -- เคสใหม่: จ่ายงวดเดือนนี้แล้ว ห้ามมี 2 งวดในเดือนเดียว (วันนี้ 16 พ.ย. 2026)
    (date '2026-11-16', 30, 1, date '2026-11-05', date '2026-12-30'),
    (date '2026-11-16', 30, 3, date '2026-11-05', date '2027-02-28'),
    (date '2026-11-16', 30, 1, date '2026-10-22', date '2026-11-30'),
    (date '2026-11-16', 30, 1, date '2026-12-20', date '2027-01-30'),
    (date '2026-11-16', 30, 1, null::date,        date '2026-11-30'),
    (date '2026-11-16', 16, 1, date '2026-10-22', date '2026-12-16')
  ) t(today, dd, i, lastpaid, expected) loop
    got := pg_temp.rdd(r.today, r.dd, r.i, r.lastpaid);
    out := out || format(E'\n%s today=%s day=%s i=%s lastpaid=%s got=%s expected=%s',
      case when got = r.expected then 'PASS' else 'FAIL' end, r.today, r.dd, r.i, r.lastpaid, got, r.expected);
  end loop;
  raise exception 'RESULT (rollback):%', out;
end
$do$;
