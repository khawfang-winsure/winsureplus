// pj-sync/dueDayShift.ts
//
// ฟังก์ชันบริสุทธิ์ (pure — ไม่มี network/DB/side effect ใดๆ) ตัดสินใจว่าจะ "เลื่อนวันครบกำหนดงวด
// อัตโนมัติ" ให้สัญญา active ได้หรือไม่ เมื่อ PJ มีใบเสร็จประเภท "อื่นๆ" (เช่น ค่าธรรมเนียมเปลี่ยนวัน
// ชำระ 500 บาท) และตารางงวดของ PJ แสดงวันครบกำหนดใหม่ที่ต่างจากของเรา
//
// อนุมัติโดยคุณเตย 21 ก.ย. 2026 — งาน "PJ เลื่อนวันครบกำหนดให้เอง" (เฉพาะเคสง่าย เคสซับซ้อนเข้ากล่อง
// รอตรวจ) ตรรกะในไฟล์นี้ต้องตรงกับที่ครีมแก้มือ 8 สัญญาไปแล้ววันนี้ทุกประการ (ดู
// dueDayShift.test.ts สำหรับชุดทดสอบที่ยืนยันด้วยเคสจริง):
//   S00006PNQ033 (25→สิ้นเดือน), S00015PNQ060 (25→2), S00017PNQ128 (27→1), S00017PNQ186 (3→8),
//   S00018PNQ052 (28→1), S00018PNQ233 (17→5), S00023PNQ002 (7→15), S00032PNQ062 (31→5)
//
// วิธีที่ครีมแก้มือ (ตรรกะที่ไฟล์นี้ต้องทำให้เหมือน):
//   เฉพาะงวดที่ paid_amount = 0 และ due_date > current_date เท่านั้นที่ถูกเลื่อน:
//     due_date ใหม่ = make_date(ปีเดิม, เดือนเดิม, least(วันใหม่, วันสุดท้ายของเดือนนั้น))
//   จับคู่งวดด้วย "เดือนเดียวกัน" ระหว่างงวด Pending ของ PJ กับงวดค้างของเรา และจำนวนงวด Pending
//   ต้องเท่ากับจำนวนงวดค้างของเราด้วย ไม่แตะงวดที่จ่ายแล้วเลย
//
// ห้ามเขียน type/interface ที่ผูกกับ Deno/Supabase ไว้ในไฟล์นี้ — ให้ index.ts (Edge Function) เป็นคน
// map ข้อมูลดิบจาก PJ/DB มาเป็น input ของฟังก์ชันนี้ก่อนเรียก (defensive field-name guessing อยู่ที่
// index.ts ทั้งหมด ตาม convention เดิมของไฟล์นั้น — ไฟล์นี้เก็บแค่ "กติกาตัดสินใจ" ล้วนๆ ทดสอบง่าย)

/** ประเภทของแถวในตารางงวด PJ (จาก endpoint /manager/ajax/invoice-items/{uuid}) */
export type PjScheduleType = "installment" | "penalty" | "other" | "down" | "unknown";

/** สถานะของแถวในตารางงวด PJ — "Paid" / "Pending" / "Partial" ตามที่ PJ แสดง */
export type PjScheduleStatus = "paid" | "pending" | "partial" | "unknown";

export interface PjScheduleRow {
  type: PjScheduleType;
  /** จำนวนเงินของแถวนี้ (ยอดเต็มของงวด ไม่ใช่ยอดที่จ่ายแล้ว — ใช้เทียบกับ monthly_payment ของเรา) */
  amount: number;
  /** วันครบกำหนด/วันผ่อนชำระของแถวนี้ตาม PJ — 'YYYY-MM-DD' หรือ null ถ้าอ่านไม่ได้ */
  dueDate: string | null;
  status: PjScheduleStatus;
}

export interface OurInstallment {
  id: string;
  installmentNo: number;
  amount: number;
  paidAmount: number;
  /** 'YYYY-MM-DD' */
  dueDate: string;
}

export interface DueDayShiftUpdate {
  installmentId: string;
  installmentNo: number;
  oldDueDate: string;
  newDueDate: string;
  /** ยอดค่างวด (เท่ากันทั้งฝั่งเราและ PJ ณ จุดที่ auto_shift ตัดสินใจแล้ว) — ใช้ประกอบ raw_json ฝั่ง caller */
  amount: number;
}

export type DueDayShiftDecision =
  // ไม่มีงวดค้างที่ยังไม่ถึงกำหนดเลย (paid_amount=0 && due_date>today) — ไม่มีอะไรให้เลื่อน เคสนี้
  // ไม่จำเป็นต้อง auto-shift แต่ผู้เรียกควรพิจารณาว่ายังต้อง flag ให้คนดูไหม (มีใบ "อื่นๆ" ที่ยังไม่รู้
  // ว่าคืออะไรอยู่ดี) — ฟังก์ชันนี้แค่รายงานสถานะ ไม่ตัดสินใจแทนผู้เรียก
  | { kind: "no_candidates"; detail: string }
  // (21 ก.ย. 2026 รอบแก้ที่ 2 — ติ๊ก RED #3) วันครบกำหนดของทุกงวดตรงกับ PJ อยู่แล้ว ไม่มีอะไรต้องแก้จริง
  // (เช่น รอบก่อนเลื่อนไปแล้ว แต่ event "อื่นๆ" คนละใบมาซ้ำ) — caller ต้อง "ไม่" เลื่อน/ลงค่าธรรมเนียมซ้ำ
  | { kind: "no_op"; detail: string }
  // เข้าเงื่อนไข "ง่าย" ครบทุกข้อ — เลื่อนอัตโนมัติได้เลย (มีแต่งวดที่ "วันจริงต้องเปลี่ยน" เท่านั้น —
  // งวดที่วันตรงกับ PJ อยู่แล้วถูกตัดออกจาก updates ไปแล้ว ดู no_op ด้านบนถ้าตัดออกจนว่างหมด)
  | { kind: "auto_shift"; newDueDay: number; updates: DueDayShiftUpdate[] }
  // ไม่เข้าเงื่อนไขง่าย — ต้องเข้ากล่องรอตรวจให้คนตัดสินใจเอง พร้อมเหตุผล + ตารางเทียบ
  | {
      kind: "review";
      reasonDetail: string;
      comparison: {
        ourCandidates: OurInstallment[];
        pjPendingInstallmentRows: PjScheduleRow[];
      };
    };

function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function yearMonthKey(ymd: string): string | null {
  const p = parseYmd(ymd);
  if (!p) return null;
  return `${p.y}-${String(p.m).padStart(2, "0")}`;
}

/** จำนวนวันในเดือนนั้น (1-12) ปีนั้น — ใช้ Date.UTC กันปัญหา DST/timezone (เทียบแค่ปฏิทิน ไม่มีเวลา) */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function makeDateClamped(y: number, m: number, day: number): string {
  const clamped = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

const AMOUNT_EPSILON = 0.01;

export function decideDueDayShift(params: {
  pjSchedule: PjScheduleRow[];
  /** งวดทั้งหมดของสัญญา (ฟังก์ชันนี้กรอง unpaid+ยังไม่ถึงกำหนดเองข้างใน) */
  ourInstallments: OurInstallment[];
  /** 'YYYY-MM-DD' — วันนี้ (ตาม timezone ที่ caller ใช้เทียบ due_date เดิมทั้งระบบ) */
  today: string;
}): DueDayShiftDecision {
  const { pjSchedule, ourInstallments, today } = params;

  // ── 1) งวดของเราที่ "ยังจ่ายไม่ครบเลย" (paid_amount=0) และ "ยังไม่ถึงกำหนด" (due_date > today) —
  //    ตรงกับเงื่อนไขที่ครีมใช้ตอนแก้มือเป๊ะ เรียงตามวันครบกำหนดจากใกล้ไปไกล ──────────────────────
  const ourCandidates = ourInstallments
    .filter((i) => i.paidAmount === 0 && i.dueDate > today)
    .slice()
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.installmentNo - b.installmentNo));

  if (ourCandidates.length === 0) {
    return { kind: "no_candidates", detail: "ไม่มีงวดค้างที่ยังไม่ถึงกำหนด (paid_amount=0 && due_date>today)" };
  }

  // ── 2) งวด Pending ฝั่ง PJ (เฉพาะประเภทค่างวด) — เรียงตามวันครบกำหนดจากใกล้ไปไกลเหมือนกัน ────
  //    (คำนวณก่อน anyPartial ด้านล่าง เพื่อให้แนบ comparison เต็มๆ ได้แม้เจอ partial)
  const pjPending = pjSchedule
    .filter((r) => r.type === "installment" && r.status === "pending")
    .slice()
    .sort((a, b) => {
      if (a.dueDate == null && b.dueDate == null) return 0;
      if (a.dueDate == null) return 1;
      if (b.dueDate == null) return -1;
      return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
    });

  // ── 3) มีงวดจ่ายบางส่วนใน PJ (ประเภทค่างวด) ปนอยู่ที่ไหนก็ตาม → ห้าม auto ทันที (กติกาข้อ 3) ──
  const anyPartial = pjSchedule.some((r) => r.type === "installment" && r.status === "partial");
  if (anyPartial) {
    return {
      kind: "review",
      reasonDetail: "มีงวดจ่ายบางส่วน (Partial) ในตารางงวด PJ — ต้องให้คนตรวจ",
      comparison: { ourCandidates, pjPendingInstallmentRows: pjPending },
    };
  }

  if (pjPending.some((r) => r.dueDate == null)) {
    return {
      kind: "review",
      reasonDetail: "อ่านวันครบกำหนดจากตารางงวด PJ ไม่ได้ครบทุกแถว (dueDate = null)",
      comparison: { ourCandidates, pjPendingInstallmentRows: pjPending },
    };
  }

  // ── 4) จำนวนงวด Pending ของ PJ ต้องเท่ากับจำนวนงวดค้างของเรา (กติกาข้อ 2) ──────────────────
  if (pjPending.length !== ourCandidates.length) {
    return {
      kind: "review",
      reasonDetail:
        `จำนวนงวด Pending ของ PJ (${pjPending.length}) ไม่เท่ากับจำนวนงวดค้างของเรา (${ourCandidates.length})`,
      comparison: { ourCandidates, pjPendingInstallmentRows: pjPending },
    };
  }

  // ── 5) จับคู่ตามลำดับวันครบกำหนด (ทั้งสองฝั่งเรียงจากใกล้ไปไกลแล้ว) แล้วเช็คทีละคู่:
  //    - เดือน/ปีต้องตรงกัน ("จับคู่งวดด้วยเดือนเดียวกัน" — วันเปลี่ยนได้ แต่เดือนต้องเดิม)
  //    - ยอดเงินต้องเท่ากัน (ยอมรับคลาดเคลื่อนเล็กน้อยจากการปัดเศษ)
  const pairs: { our: OurInstallment; pj: PjScheduleRow }[] = [];
  for (let idx = 0; idx < ourCandidates.length; idx++) {
    const our = ourCandidates[idx];
    const pj = pjPending[idx];
    const ourYm = yearMonthKey(our.dueDate);
    const pjYm = pj.dueDate ? yearMonthKey(pj.dueDate) : null;
    if (!ourYm || !pjYm || ourYm !== pjYm) {
      return {
        kind: "review",
        reasonDetail:
          `งวดที่ ${our.installmentNo} ของเรา (เดือน ${ourYm ?? "?"}) จับคู่กับ Pending ของ PJ ไม่ตรงเดือน ` +
          `(PJ = ${pjYm ?? "?"}) — วันไม่สม่ำเสมอ ต้องให้คนตรวจ`,
        comparison: { ourCandidates, pjPendingInstallmentRows: pjPending },
      };
    }
    if (Math.abs(pj.amount - our.amount) > AMOUNT_EPSILON) {
      return {
        kind: "review",
        reasonDetail:
          `งวดที่ ${our.installmentNo} ยอดไม่ตรงกัน — ของเรา ${our.amount} vs PJ ${pj.amount}`,
        comparison: { ourCandidates, pjPendingInstallmentRows: pjPending },
      };
    }
    pairs.push({ our, pj });
  }

  // ── 6) หา "วันใหม่ที่ตั้งใจ" จากวันที่มากสุดที่สังเกตได้ใน PJ Pending (เดือนสั้นจะถูก clamp ลงมา
  //    เองตามธรรมชาติ ไม่ทำให้ตัวเลขที่แท้จริงหาย — ตราบใดมีอย่างน้อย 1 เดือนที่ยาวพอ) ──────────
  const newDueDay = Math.max(...pairs.map((p) => parseYmd(p.pj.dueDate as string)!.d));

  // ── 7) ทุกแถวต้องตรงกับ "วันใหม่ที่ตั้งใจ" นี้พอดี (clamp ตามความยาวเดือนของแถวนั้น) — ถ้าไม่ตรง
  //    แปลว่าวันไม่สม่ำเสมอจริง (ไม่ใช่แค่ปลายเดือนสั้นกว่า) → review ──────────────────────────
  for (const p of pairs) {
    const parsed = parseYmd(p.pj.dueDate as string)!;
    const expectedDay = Math.min(newDueDay, daysInMonth(parsed.y, parsed.m));
    if (parsed.d !== expectedDay) {
      return {
        kind: "review",
        reasonDetail:
          `งวดที่ ${p.our.installmentNo} วันครบกำหนดของ PJ (${p.pj.dueDate}) ไม่ตรงกับรูปแบบวันใหม่เดียวกัน ` +
          `(คาดว่าจะเป็นวันที่ ${expectedDay}) — วันไม่สม่ำเสมอ ต้องให้คนตรวจ`,
        comparison: { ourCandidates, pjPendingInstallmentRows: pjPending },
      };
    }
  }

  // ── 8) คำนวณ due_date ใหม่ของงวดเรา — เอาเฉพาะงวดที่ "วันจริงต้องเปลี่ยน" เท่านั้น (oldDueDate !==
  //    newDueDate) งวดที่วันตรงกับ PJ อยู่แล้ว (เคยเลื่อนไปแล้วรอบก่อน หรือบังเอิญตรงพอดี) ข้ามไปเลย
  //    ไม่ต้องแตะ ไม่ต้องนับเป็นการ "แก้" ──────────────────────────────────────────────────────
  const updates: DueDayShiftUpdate[] = [];
  for (const p of pairs) {
    const oldParsed = parseYmd(p.our.dueDate)!;
    const newDueDate = makeDateClamped(oldParsed.y, oldParsed.m, newDueDay);
    if (newDueDate === p.our.dueDate) continue; // ตรงกับ PJ อยู่แล้ว — ไม่ต้องแก้งวดนี้
    updates.push({
      installmentId: p.our.id,
      installmentNo: p.our.installmentNo,
      oldDueDate: p.our.dueDate,
      newDueDate,
      amount: p.our.amount,
    });
  }

  // (21 ก.ย. 2026 รอบแก้ที่ 2 — ติ๊ก RED #3) ไม่มีงวดไหนต้องแก้จริงเลย = วันตรงกับ PJ ครบทุกงวดอยู่แล้ว
  // → no_op เด็ดขาด ห้าม caller เลื่อนซ้ำ/ลงค่าธรรมเนียมซ้ำ (กันเคส event "อื่นๆ" คนละใบมาซ้ำหลังจากที่
  // เคยเลื่อนสำเร็จไปแล้วรอบก่อน — เช่น idempotency marker เขียนไม่สำเร็จ แล้วรอบหน้ามาเจอ invoice/
  // paid_date ใหม่ที่ยังไม่เคยถูก mark แต่ข้อมูลจริงถูกต้องอยู่แล้ว)
  if (updates.length === 0) {
    return { kind: "no_op", detail: "วันครบกำหนดของทุกงวดตรงกับตารางงวด PJ อยู่แล้ว ไม่ต้องเลื่อน" };
  }

  // ── 9) เช็คว่าไม่มีงวดไหน (ที่ "จะแก้จริง") กลายเป็นเลยกำหนดทันทีหลังเลื่อน (กติกาข้อ 2) ─────────
  for (const u of updates) {
    if (!(u.newDueDate > today)) {
      return {
        kind: "review",
        reasonDetail:
          `งวดที่ ${u.installmentNo} ถ้าเลื่อนเป็นวันที่ ${u.newDueDate} จะกลายเป็นเลยกำหนดทันที (วันนี้ ${today}) — ต้องให้คนตรวจ`,
        comparison: { ourCandidates, pjPendingInstallmentRows: pjPending },
      };
    }
  }

  return { kind: "auto_shift", newDueDay, updates };
}
