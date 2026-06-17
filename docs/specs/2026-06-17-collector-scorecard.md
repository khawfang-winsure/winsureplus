# Spec: Collector Scorecard (ย้อนหลังตามช่วงวัน) — 2026-06-17

ผู้รับงาน: น้องชีส (DB) → น้องวิว (UI). โหมด additive ห้ามแตะ flow เดิม

## Decisions locked by Pete (2026-06-17)
- **Attribution = INFER** (ย้อนหลังจากข้อมูลเดิม ไม่เพิ่มขั้นตอนกรอก)
- **Multi-caller = LAST-TOUCH** — สายโทร (`contact_method='phone'`) ที่ใกล้ก่อนการจ่ายที่สุด ได้เครดิตยอดเต็มก้อนนั้น (ไม่หาร)
- **Scope = FREELANCER ONLY** (`role='freelancer'`) — ไม่รวม staff
- **Window = 7 วัน** — การจ่าย credited ให้คนที่โทรสัญญานั้นภายใน 7 วันก่อนวันจ่าย
- **Range = arbitrary [start,end]** — เลิกใช้ 7/30/90 rolling cap สำหรับ view นี้

---

## 1. New DB migration — `0046_collector_scorecard.sql`

เลขถัดจาก 0045. additive: `create or replace function` เท่านั้น ไม่ drop ของเดิม (`get_freelancer_perf`/`get_promise_attribution`/views คงไว้ — WeeklyReport ยังเรียกอยู่)

### Function signature
```sql
create or replace function public.get_collector_scorecard(
  p_start date,
  p_end   date
)
returns table (
  author_id          uuid,
  calls              int,      -- (b)
  unique_contracts   int,      -- (c) distinct CONTRACT ไม่ใช่ลูกค้า
  total_attempts     int,      -- ทุกช่องทาง (สำหรับ contact-rate denominator)
  successful_attempts int,     -- result ∈ (contacted,promised,paid,returned,other)
  collected_baht     numeric,  -- (a) last-touch attribution
  last_activity_at   timestamptz
)
language sql
stable
security definer                       -- ต้อง DEFINER (อ่าน payment_log + follow_ups ข้าม role)
set search_path = public, pg_catalog
as $$ ... $$;

grant execute on function public.get_collector_scorecard(date, date)
  to authenticated, service_role;
```

### Guard (ต้นฟังก์ชัน — เหมือน pattern เดิมใน 0018 RPCs)
`get_freelancer_perf` เดิมใช้ `security invoker` ปล่อยให้ RLS คุม. **อันนี้ใช้ `security definer`** เพราะ last-touch ต้อง self-join `follow_ups` + `payment_log` ในระดับ row ที่ RLS invoker อาจทำ plan แพง/ซับซ้อน. เพราะ DEFINER ข้าม RLS → **ต้อง guard เองด้วย SQL function ไม่สามารถ `raise exception`** ดังนั้นใช้วิธี: ห่อ logic ด้วย `where is_admin() or is_staff()` ที่ระดับ outer (ถ้า caller ไม่ใช่ admin/staff → คืน 0 rows). ถ้าน้องชีสจะใช้ plpgsql แทน sql เพื่อ `raise exception` แบบ record_payment ก็ได้ — เลือกแบบใดแบบหนึ่ง แต่ **freelancer ห้ามเรียกแล้วเห็นข้อมูลคนอื่น**. (View นี้ใช้บนหน้า admin/staff เท่านั้น)

### Logic แต่ละ metric

**TZ convention (ยึดตาม 0028):** ทุกการ slice วันจาก `timestamptz` ใช้ `(ts at time zone 'Asia/Bangkok')::date`. range เทียบแบบ inclusive ทั้งสองด้าน: `... between p_start and p_end`.

**Freelancer set:** ทุก CTE join `profiles pr on pr.id = <author> and pr.role = 'freelancer'` (และควร `and pr.active = true` ให้ตรงกับ db.ts step 1). คน role อื่นที่โทรจะถูกตัดทั้ง numerator ของ (a) และ count (b)/(c).

**(a) collected_baht — LAST-TOUCH:**
```
1. paid_events: payment_log แต่ละแถว action='pay'
   ที่ (created_at at tz 'Asia/Bangkok')::date between p_start and p_end
   เก็บ (payment_id, contract_id, amount, created_at as paid_ts)
   — ไม่ dedup ระดับ contract: จ่ายหลายก้อน/บางส่วน = หลายแถว นับทุกก้อน
2. last_call: สำหรับแต่ละ paid_event หา follow_up 1 แถวที่
     - contract_id ตรงกัน
     - contact_method = 'phone'
     - author เป็น freelancer (join profiles role)
     - created_at < paid_ts (strictly before)
     - created_at >= paid_ts - interval '7 days'
   เลือกแถว created_at มากสุด (ใกล้ paid_ts สุด) → DISTINCT ON (payment_id) ... ORDER BY paid_ts desc, follow_ups.created_at desc
3. tie-break (สองสายเวลาเป๊ะกัน): order by created_at desc, then follow_ups.id desc → deterministic 1 ผู้ชนะ
4. ไม่มี qualifying call → payment ไม่ถูก join → ไม่ credited ใคร (ตกเป็น uncredited, ดู §4)
5. collected_baht = SUM(amount) group by ผู้ชนะ author_id
```
ใช้ `distinct on (pe.payment_id)` (Postgres) เป็นวิธีตรงสุดสำหรับ last-touch. `payment_log` ไม่มี PK ชื่ออื่น — ใช้ `pl.id`.

**(b) calls:**
```
count(*) from follow_ups
where contact_method = 'phone'
  and author = freelancer
  and (created_at at tz 'Asia/Bangkok')::date between p_start and p_end
group by author_id
```

**(c) unique_contracts:** `count(distinct contract_id)` จาก follow_ups (ทุก contact_method) ของ freelancer ในช่วง. **label UI = "สัญญาที่ดูแล"** ไม่ใช่ "ลูกค้า" (1 ลูกค้าอาจมีหลายสัญญา).

**total_attempts / successful_attempts:** เหมือน `get_freelancer_perf` แต่กรอง freelancer + ช่วง [start,end] — ใช้เป็น denominator ของ contact-rate.

**Output:** FULL OUTER JOIN CTE ทั้งหมดบน author_id, `coalesce(...,0)`. รวม freelancer ที่ไม่มี activity (db.ts จะเติม row ที่เหลือเองจาก profiles อยู่แล้ว — ดู §2 — ดังนั้นฟังก์ชันคืนเฉพาะคนที่มี activity ก็พอ แต่ FULL OUTER JOIN ภายในกันเลขเพี้ยน)

### Extra metrics — คำนวณฝั่ง client (ไม่ต้องอยู่ใน SQL)
- **฿/call** = collected_baht ÷ calls — guard calls=0 → null (N/A)
- **contact-rate** = successful_attempts ÷ total_attempts ×100 — guard 0 → null
- **leaderboard / per-grade / team summary** = reuse ของเดิม. per-grade breakdown (drill-down) **ยังดึงจาก `get_freelancer_perf` เดิม** ได้ ถ้าต้องการ per-grade ในช่วง arbitrary ต้องเพิ่ม grade ใน return ของ scorecard (optional, phase 2 — ไม่ใช่ MVP).

### Uncredited total (เพื่อ reconcile ฿ — ดู §4)
เพิ่ม function เล็กคู่กัน หรือ return เป็น row พิเศษ:
```sql
create or replace function public.get_uncredited_collected(p_start date, p_end date)
returns numeric ...  -- SUM(amount) ของ payment 'pay' ในช่วงที่ "ไม่มี" qualifying phone call ใน 7 วันก่อน
```
เพื่อให้ UI โชว์ "ยอดที่ไม่มีสายนำ ฿X" → ผลรวม collected ต่อคน + uncredited = ยอด pay ทั้งหมดในช่วง (ตรวจ reconcile ได้).

---

## 2. db.ts helper

เพิ่ม getter ใหม่ (ไม่แก้ `getFreelancerPerformance` เดิม — WeeklyReport ใช้อยู่):

```ts
export interface CollectorScorecardRow {
  authorId: string
  fullName: string
  assignedGrades: string[]      // จาก freelancer_grade_assignments (reuse step 2 เดิม)
  calls: number                 // (b)
  uniqueContracts: number       // (c) — label "สัญญาที่ดูแล"
  totalAttempts: number
  successfulAttempts: number
  collectedBaht: number         // (a)
  bahtPerCall: number | null    // client: collectedBaht / calls, null ถ้า calls=0
  contactRate: number | null    // client: successful/total ×100, null ถ้า total=0
  lastActivityAt: string | null
}

export interface CollectorScorecardResult {
  rows: CollectorScorecardRow[]
  uncreditedBaht: number        // จาก get_uncredited_collected
}

export async function getCollectorScorecard(
  start: string,   // 'YYYY-MM-DD'
  end: string,
): Promise<CollectorScorecardResult>
```

Implementation:
1. ดึง freelancer profiles (`role='freelancer'`, `active=true`) — reuse step 1 เดิม (db.ts:2522)
2. ดึง grade assignments — reuse step 2 เดิม (db.ts:2537)
3. `supabase.rpc('get_collector_scorecard', { p_start: start, p_end: end })`
4. `supabase.rpc('get_uncredited_collected', { p_start: start, p_end: end })`
5. merge เป็น 1 row ต่อ freelancer ทุกคน (คนไม่มี activity = all-zero, เหมือน map สุดท้าย db.ts:2654). คำนวณ `bahtPerCall` / `contactRate` ฝั่ง client (guard หารศูนย์ → null)
- ถ้า `!supabase` → คืน `{ rows: [], uncreditedBaht: 0 }`
- `collected_baht` มาเป็น string/numeric จาก PostgREST → `Number(...)` เหมือน promiseKeptCredit เดิม

---

## 3. UI — StaffPerformance.tsx

1. **เปลี่ยน dropdown 7/30/90 → `<DateRangePicker>`** (`src/components/DateRangePicker.tsx`)
   - props: `storageKey="staff-performance.dateRange"`, `defaultPreset="thisMonth"`
   - state: `const [range, setRange] = useState<DateRange | null>(() => loadStoredRange('staff-performance.dateRange', 'thisMonth'))`
   - `range === null` ("ทั้งหมด") → ต้องเลือกขอบเขต default ให้ฟังก์ชัน: ส่ง `start='2020-01-01'`, `end=todayISO`. (อย่าส่ง null เข้า RPC date param)
   - เรียก `getCollectorScorecard(range.start, range.end)` ใน useEffect deps `[range]`
2. **คอลัมน์/การ์ดใหม่** (3 ตัวหลัก + ฿/call):
   - การ์ดสรุปบน: เพิ่ม "ยอดเก็บจากการโทร (รวมทีม)" + "ยอดที่ไม่มีสายนำ" (จาก uncreditedBaht, สี amber/มุทำ)
   - ตาราง leaderboard เพิ่มคอลัมน์: **ยอดเก็บจากโทร (฿)**, **จำนวนสาย**, **สัญญาที่ดูแล**, **฿/สาย**
   - คง Contact/Promise/Keep/Resolution/Escalation เดิมไว้ได้ (ถ้า phase 1 ตัด attribution KPI ที่ผูก promise ออกก็ได้ เพราะ scorecard ใหม่ไม่คืน promise fields — **ตัดสินใจ:** MVP โชว์ 3 ตัวหลัก + ฿/call + contact-rate; KPI promise/keep/escalation เดิมให้คงไว้เฉพาะถ้ายังเรียก `getFreelancerPerformance` คู่กัน — ไม่บังคับใน MVP)
   - format เงิน: `฿${n.toLocaleString('th-TH')}` (ตามที่หน้าใช้กับค่าคอมคืนเครื่องอยู่แล้ว)
   - N/A: `bahtPerCall`/`contactRate` = null → โชว์ "N/A" (reuse `fmtRate`)
3. **CSV export** — เพิ่ม header + cell: ยอดเก็บจากโทร, จำนวนสาย, สัญญาที่ดูแล, ฿/สาย (ต่อจาก column เดิม). คง BOM + escCell เดิม
4. **PageTitle sub** — เปลี่ยนจาก `ข้อมูล ${daysWindow} วันล่าสุด` → label ช่วงจาก DateRangePicker (มี helper `fmtThaiShort`/`daysBetween` export มาแล้ว)

---

## 4. Edge cases & gotchas

- **จ่ายบางส่วน / หลายก้อนต่อสัญญา:** `payment_log` มีหลายแถว action='pay' ต่อสัญญาได้ (จ่ายบางส่วน = หลาย row). **นับทุกแถวแยกกัน** — แต่ละก้อนหา last-touch ของตัวเอง (สายที่นำก่อนก้อนนั้น ภายใน 7 วัน) ไม่ dedup ระดับสัญญา. ผลรวม collected ต่อคน = ผลรวมก้อนที่ชนะ.
- **จ่ายแต่ไม่มีสายนำใน 7 วัน → uncredited:** ไม่โยนให้ใคร. **ต้องโชว์ "ยอดที่ไม่มีสายนำ" รวม** (จาก `get_uncredited_collected`) เพื่อให้ Σ(ต่อคน) + uncredited = ยอด pay ทั้งหมดในช่วง — พี่พิธ reconcile ได้ว่าเงินไม่หาย.
- **action edit/cancel:** นับเฉพาะ `action='pay'` (เหมือน WeeklyReport/cashflow เดิม). edit/cancel ไม่ใช่เงินเข้าใหม่.
- **คนคีย์ ≠ คนโทร:** `payment_log.acted_by` = คนคีย์ (admin/staff) — **อย่าใช้เป็น attribution**. attribution มาจาก follow_up phone เท่านั้น.
- **TZ:** `created_at` เป็น `timestamptz`. slice เป็นวันด้วย `at time zone 'Asia/Bangkok'` ทุกที่ (ยึด 0028). ขอบเขต 7 วันเทียบที่ระดับ timestamp (`paid_ts - interval '7 days'`) ไม่ใช่ระดับ date เพื่อความแม่น "ภายใน 7 วันก่อนจ่ายจริง".
- **follow_ups append-only:** ไม่มี UPDATE/DELETE — ปลอดภัยใช้เป็นหลักฐาน attribution ย้อนหลัง.
- **staff โทรแล้วลูกค้าจ่าย:** ตาม decision FREELANCER ONLY — สายของ staff ไม่นับ ถ้าก่อนจ่ายมีแต่สาย staff (ไม่มีสาย freelancer ใน 7 วัน) → ยอดนั้น **uncredited** (ตกถังไม่มีสายนำ) ถูกต้องตาม scope.
- **range = null (ทั้งหมด):** DateRangePicker คืน null ได้ — UI ต้อง map เป็น start/end จริงก่อนส่ง RPC (date param รับ null ไม่ได้).
- **performance:** last-touch self-join อาจหนักถ้าช่วงกว้าง + payment เยอะ. index ช่วย: `follow_ups (contract_id, created_at desc)` มีแล้ว (0018:85); `payment_log_contract_idx` มีแล้ว (0011:39). น่าจะพอ — ถ้าช้าให้น้องชีสเพิ่ม partial index `follow_ups(contract_id, created_at) where contact_method='phone'`.

---

## Checklist ส่งมอบ
- [ ] 0046 apply ผ่าน MCP + `has_function_privilege('authenticated','public.get_collector_scorecard(date,date)','EXECUTE')` = true
- [ ] smoke: `select * from get_collector_scorecard('2026-05-01','2026-05-31')` ไม่ error
- [ ] reconcile: Σ collected ต่อคน + uncredited = Σ payment_log pay ในช่วง (ตรวจ 1 เดือนจริง)
- [ ] freelancer เรียกแล้วเห็น 0 rows / เห็นเฉพาะที่อนุญาต (ไม่หลุดข้อมูลคนอื่น)
- [ ] UI: DateRangePicker เปลี่ยนช่วง → ตารางอัปเดต, CSV มี column ใหม่, N/A render ถูก
- [ ] npm run build clean (TS strict)
