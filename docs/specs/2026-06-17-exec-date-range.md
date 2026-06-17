# SPEC — Date Range Picker บน Executive Dashboard `/exec`

**วันที่:** 2026-06-17
**ผู้เขียน:** แบม (BA)
**Owner:** Pete
**ไฟล์ที่กระทบ:** `src/pages/ExecDashboard.tsx`, `src/lib/execDashboard.ts`
**Specialists:** น้องชีส (lib), น้องวิว (UI)

---

## ปัญหาที่ต้องแก้

ตอนนี้ `/exec` แสดงข้อมูล ณ วันนี้ + KPI บางตัวบังคับ scope = "เดือนนี้" (เช่น `receivedThisMonth`, `extensionsThisMonth`). Pete อยากเลือกช่วงเอง เช่น "วันที่ 1–3" เพื่อดูภาพรวมแคบลง หรือเทียบช่วง

---

## 1. แต่ละ section ใช้ระยะเวลาแบบไหน

หลักการ: **KPI ที่เกี่ยวกับ "การไหลของเงิน/เคส" → filter ตามช่วง**, **KPI ที่เกี่ยวกับ "สถานะคงค้าง/สุขภาพพอร์ต" → snapshot ณ วันนี้** (range ไม่กระทบ)

| Section | พฤติกรรม | เหตุผล |
|---|---|---|
| KPI tile: ลูกค้าทั้งหมด/active/closed | **snapshot ณ วันนี้** | จำนวนสัญญาเป็น state ไม่ใช่ flow |
| KPI tile: portfolio payable/finance/collected/outstanding | **snapshot ณ วันนี้** | ยอดพอร์ตคือ state ปัจจุบัน — Pete ถามว่า "ตอนนี้คงค้างเท่าไร" |
| KPI tile: NPL% + bad debt value | **snapshot ณ วันนี้** | หนี้เสีย = ล่าช้า ≥ 60 วัน ณ วันนี้ ใส่ range แล้วผิดความหมาย |
| Donut สุขภาพลูกค้า | **snapshot ณ วันนี้** | เหมือนกัน |
| Aging buckets (1-10, 11-30, …) | **snapshot ณ วันนี้** | เหมือนกัน |
| **รับชำระในช่วง** (เดิม `receivedThisMonth`) | **filter ตาม range** (b: `payments.createdAt` ∈ range) | นี่คือสิ่งที่ Pete อยากเปลี่ยน — "วัน 1-3 เก็บได้กี่บาท" |
| **คาดเก็บในช่วง** (เดิม `expectedThisMonth/NextMonth`) | **filter ตาม range** (งวด `dueDate` ∈ range, ส่วน remain) | ดูยอดที่ต้องเก็บใน window |
| Collection rate | **snapshot ณ วันนี้** (ตัวหารคืออดีตทั้งหมด, ไม่ใช่ window) | ตัวเลขเฉพาะช่วงสั้นๆ ผันผวนสูง ไม่ตรงตามเจตนา |
| ค่าปรับค้างรวม | **snapshot ณ วันนี้** | state ปัจจุบัน |
| **เคสใหม่ในช่วง** (เดิม `newContractsThisMonth`) | **filter ตาม range** (a: `transactionDate` ∈ range) | นี่คือ flow — ตรงประเด็น |
| **ร้านใหม่ในช่วง** (เดิม `newShopsThisMonth`) | **filter ตาม range** (เคสแรกของร้าน ∈ range) | flow |
| **ขอขยายเวลาในช่วง** | **filter ตาม range** | flow |
| **คืนเครื่องในช่วง** | **filter ตาม range** | flow |
| Early default (ไม่จ่ายงวดแรก) | **snapshot ณ วันนี้** | สถานะ |
| Top shops / กราฟเกรด / Risky / Silent | **snapshot ณ วันนี้** | reputation ของร้านอิงทั้งประวัติ — ใส่ range จะดูเหมือนร้านดี/แย่ปลอม |
| Roll/Cure rate chart (grade movement) | **snapshot timeseries เดิม 12 เดือน** ไม่ผูก range | กราฟตัวนี้มี timeline ของตัวเอง |
| Trend 12 เดือน (New cases, Collected, Portfolio) | **ไม่ผูก range** | กราฟแสดงประวัติ — ถ้าผูก range จะกลายเป็นกราฟแคบ ไม่มีค่า |
| ESCALATE aggregate | **snapshot ณ วันนี้** | สถานะปัจจุบัน |
| Cashflow tab (day/week/month) | **filter ตาม range** (override `count` ของ buildCashflow) | ใส่ range = เลือกช่วงเปรียบเทียบโดยตรง |
| Bottleneck widget | **snapshot ณ วันนี้** | เคสค้างปัจจุบัน |
| Morning Briefing (commission, alerts) | **snapshot + เดือนนี้เดิม** ไม่ผูก range (phase 2 ค่อยคิด) | เพื่อ scope งานไม่ใหญ่เกิน |

---

## 2. ความหมายของ "ช่วง A–B" — เลือก 1 ต่อกลุ่ม

- **กลุ่ม "ในช่วง"** ที่เป็นเงินเข้า/เก็บ → ใช้ **(b) payments.createdAt ∈ [A, B]**
- **กลุ่ม "ในช่วง"** ที่เป็นเคสใหม่/ขยาย/คืน/ร้านใหม่ → ใช้ **(a) transactionDate / createdAt ของ event ∈ [A, B]**
- **กลุ่มคาดเก็บในช่วง** → งวดที่ `dueDate ∈ [A, B]` (ส่วน remain ที่ยังไม่จ่าย)
- **กลุ่ม snapshot** → (c) state ณ todayISO ตามเดิม (ignore range)

ห้ามผสม interpretation ใน section เดียวกัน

---

## 3. Default range + Quick presets

- **Default ตอนโหลดหน้า:** "เดือนนี้" (วันที่ 1 ของเดือนนี้ → todayISO) — ตรงกับพฤติกรรมเดิม ผู้ใช้เก่าไม่งง
- **Presets (chip ปุ่ม):**
  1. วันนี้
  2. 7 วันล่าสุด
  3. 30 วันล่าสุด
  4. เดือนนี้ (default)
  5. เดือนที่แล้ว
  6. ไตรมาสนี้
  7. ทั้งหมด (range = null → ใช้พฤติกรรมเดิมทั้งหมด: เดือนนี้สำหรับ flow KPIs)
- **Custom:** date input 2 ตัว (from, to) — ใช้ `<input type="date">` ธรรมดา
- **แสดง label range ที่เลือก** ใต้ PageTitle เช่น "ช่วง: 1–3 มิ.ย. 2026 (3 วัน)" เพื่อ Pete รู้ตลอดว่ากำลังดู scope ไหน

---

## 4. `buildExecDashboard()` signature change

**ของเดิม:**
```ts
buildExecDashboard({ contracts, statuses, installments, shops, payments, extensions, returns, todayISO, ... })
```

**เสนอ:**
```ts
buildExecDashboard({
  ...,
  todayISO,
  rangeStart?: string,  // 'YYYY-MM-DD' inclusive — undefined = behavior เดิม (เดือนนี้)
  rangeEnd?: string,    // 'YYYY-MM-DD' inclusive — undefined = behavior เดิม
})
```

**Helper ที่ต้องเคารพ range (filter ตาม [rangeStart, rangeEnd]):**
- `receivedThisMonth` → rename เป็น `receivedInRange` (ภายใน) แต่ field name ใน return type **คงไว้** เพื่อไม่กระทบ UI ตอนนี้ (UI relabel เอง)
- `expectedThisMonth` → relabel เป็น `expectedInRange` (เดิม), เพิ่ม `expectedAfterRange` แทน NextMonth ถ้าจำเป็น (หรือเก็บ NextMonth ตามเดิมเป็นค่า fixed)
- `newContractsThisMonth` → ใช้ range
- `newShopsThisMonth` → ใช้ range
- `extensionsThisMonth` → ใช้ range
- `returnsThisMonth` → ใช้ range
- `cashflowDay/Week/Month` → ถ้ามี range: คำนวณ row เฉพาะช่วง (กำหนด count + start จาก range), ถ้าไม่มี range คงค่า default 14/8/12 ตามเดิม

**Helper ที่ไม่เคารพ range (snapshot ณ todayISO):**
- KPI พอร์ต (payable/finance/collected/outstanding)
- Donut + aging + NPL + bad debt
- Collection rate + penaltyTotal + grossMargin
- shopRows / topShops / silentShops / riskyShops / gradeDist
- earlyDefault
- trendLabels / newCasesByMonth / collectedByMonth / portfolioByMonth (timeseries 12 เดือนเดิม)
- riskByOccupation/Age/Model
- briefing (phase 1 ไม่แตะ)

**Default fallback:** ถ้า `rangeStart`/`rangeEnd` = undefined → ใช้ "เดือนนี้" เหมือนเดิม (จาก curMonthKey) เพื่อให้ test เก่าไม่พัง

---

## 5. Edge cases

| Case | Behavior |
|---|---|
| `rangeStart > rangeEnd` | UI: highlight แดง + ปุ่ม "ใช้ช่วง" disabled, lib: ถ้าหลุดมาถึง → swap ให้อัตโนมัติ + console.warn |
| Range อยู่ในอนาคต (start > todayISO) | อนุญาต (lib filter ปกติ จะได้ 0 หมด), UI แสดง info chip "ช่วงนี้ยังไม่มีข้อมูล" เมื่อทุก in-range KPI = 0 |
| Range ครอบช่วงยาวมาก (> 3 ปี) | อนุญาต ไม่ block แต่ Cashflow day จะ render row เยอะ — cap ที่ 366 rows ในกรณี granularity=day ถ้าเกิน auto switch เป็น month |
| Range มี 0 ข้อมูล (เก่ามาก) | KPI = 0, UI แสดง chip "ไม่มีข้อมูลในช่วงนี้" บน section flow-based |
| รีโหลด/เปลี่ยน tab | range persist ใน `localStorage` key `exec.dateRange` (ระบบจำที่หน้านี้) — รีเฟรชแล้วยังอยู่ |

---

## TL;DR — สิ่งที่ต้องเปลี่ยนในโค้ด

### น้องชีส (`src/lib/execDashboard.ts`)
1. เพิ่ม `rangeStart?: string`, `rangeEnd?: string` ใน `ExecInput`
2. คำนวณ `effectiveStart` / `effectiveEnd` ภายใน: ถ้า undefined → ใช้ "วันที่ 1 ของเดือน todayISO" ถึง todayISO
3. แก้ filter ของ: `receivedThisMonth`, `expectedThisMonth`, `newContractsThisMonth`, `newShopsThisMonth`, `extensionsThisMonth`, `returnsThisMonth` ให้ใช้ effective range แทน `curMonthKey`
4. แก้ `buildCashflow()` call: ถ้ามี range → คำนวณ count จากระยะวัน/สัปดาห์/เดือนใน range แทน hard-code 14/8/12
5. ห้ามแตะ: KPI พอร์ต, Donut/aging, shop reports, trend 12-month, risk groups, briefing, gradeMovement
6. ทุก field ใน `ExecDashboard` return type **ชื่อเดิม** (เช่น `receivedThisMonth`) — แค่ความหมายเปลี่ยนเป็น "ในช่วงที่เลือก"

### น้องวิว (`src/pages/ExecDashboard.tsx`)
1. เพิ่ม `DateRangePicker` component ที่ตอนบน (ใต้ PageTitle, เหนือ MorningBriefing) — 7 preset chips + 2 date input + label "ช่วงที่เลือก"
2. State: `const [range, setRange] = useState<{start: string, end: string} | null>(default = เดือนนี้)`
3. Persist `range` ใน `localStorage` key `exec.dateRange`
4. ส่ง `rangeStart`/`rangeEnd` เข้า `buildExecDashboard()`
5. Relabel KPI: "รับชำระเดือนนี้" → "รับชำระในช่วง", "คาดเก็บเดือนนี้" → "คาดเก็บในช่วง", "เคสใหม่เดือนนี้" → "เคสใหม่ในช่วง", etc.
6. ปล่อย Cashflow tab ใช้ rows จาก `d.cashflowDay/Week/Month` ตามเดิม (lib เป็นคนตัด range แล้ว)
7. **Tooltip/info icon** บน KPI snapshot (NPL%, outstanding, etc.) เขียนว่า "ค่านี้คำนวณ ณ วันนี้ ไม่ถูกผลกระทบจากช่วงที่เลือก" เพื่อ Pete ไม่งง

### Edge handling
- `useAsync` dep ต้องเพิ่ม `range` เพื่อ rebuild เมื่อเปลี่ยนช่วง
- ถ้า `range.start > range.end` → ปุ่ม "ใช้" disabled

### ไม่ต้องทำ (out of scope phase 1)
- Briefing ไม่ผูก range
- Forecast tab ไม่ผูก range (มี logic ของตัวเอง)
- Grade movement chart ไม่ผูก range
- ไม่มี migration / DB เปลี่ยน — pure function เท่านั้น
