// pjBlacklistParse.test.ts — Deno test (รันตอน deploy/CI ผ่าน `deno test`) — ครีมไม่มี deno ติดตั้งใน
// เครื่อง ณ วันที่เขียนไฟล์นี้ (28 ก.ย. 2026) — ตรรกะเดียวกันนี้ถูก compile+รันจริงแล้วด้วย node (tsx)
// ผ่านครบตามจำนวนเคสด้านล่าง ก่อนส่งงานกลับ (ดูรายงานในแชท)
// ไฟล์นี้คือชุดทดสอบถาวรในรีโป — ให้ครีม/ติ๊ก รัน `deno test supabase/functions/credit-check` ยืนยันซ้ำได้
//
// v2 (2026-09-28) — เขียนใหม่ทั้งไฟล์ให้ fixture ตรงกับโครง HTML จริงของ PJ ที่ครีม capture มา (ดู
// scratchpad/pj-blacklist-real-html.md, ค่าทั้งหมด anonymized ไม่มีข้อมูลลูกค้าจริงปนอยู่เลย) — v1 เดิม
// เขียน fixture จากการเดาโครงสร้างเอง (info-item ธรรมดาไม่มี .customer-card/.installment-stat) ทำให้ผ่าน
// เทสต์ตัวเองได้ทั้งที่ parser จริงพังกับ PJ จริง (เจอจาก live E2E — ดูรายงาน) fixture รอบนี้เลียนโครงจาก
// เอกสาร recon จริงเป๊ะที่สุดเท่าที่ทำได้ แต่ "ยังไม่เคย" เทียบกับ HTML จริงอีกรอบหลังแก้ (ครีม deploy +
// ยิง live E2E ซ้ำเอง)

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parsePjBlacklistHtml, PjBlacklistParseError } from "./pjBlacklistParse.ts";

// ── fixture: หน้า "ไม่พบข้อมูล" ตัวจริง — Swal.fire(...) escape ด้วย \uXXXX ไม่ใช่ข้อความไทยตรงๆ ──────
// (เขียน \\u ในซอร์ส .ts นี้เจตนา — กัน TS ตีความเป็น unicode escape ตอน compile จนกลายเป็นอักษรไทยจริง
// ไปเลย เราต้องการให้ตัวแปรนี้ "มี" อักขระ \uXXXX ดิบๆ อยู่ในสตริง เหมือนที่อยู่ในซอร์ส HTML ของ PJ จริง)
const NOT_FOUND_HTML = `
<html><body>
  <div class="card">
    <form method="POST" action="/manager/check-blacklist">
      <input type="text" name="search_value" placeholder="เลขบัตรประชาชน / IMEI / Serial">
    </form>
  </div>
  <script>
    Swal.fire({"title":"\\u0e44\\u0e21\\u0e48\\u0e1e\\u0e1a\\u0e02\\u0e49\\u0e2d\\u0e21\\u0e39\\u0e25","text":"\\u0e01\\u0e23\\u0e38\\u0e13\\u0e32\\u0e01\\u0e23\\u0e2d\\u0e01\\u0e40\\u0e25\\u0e02\\u0e1a\\u0e31\\u0e15\\u0e23\\u0e1b\\u0e23\\u0e30\\u0e0a\\u0e32\\u0e0a\\u0e19, IMEI, \\u0e2b\\u0e23\\u0e37\\u0e2d\\u0e2b\\u0e21\\u0e32\\u0e22\\u0e40\\u0e25\\u0e02\\u0e0b\\u0e35\\u0e40\\u0e23\\u0e35\\u0e22\\u0e25\\u0e41\\u0e1a\\u0e1a\\u0e40\\u0e15\\u0e47\\u0e21","icon":"error"});
  </script>
</body></html>
`;

// ── fixture: การ์ดเดียว (มี "กำหนดชำระครั้งถัดไป" nested div+span + info-item "จำนวนงวดทั้งหมด" ที่เป็น
// ยอดเงิน "38,728 THB" ผิดๆ ปนอยู่ + .installment-stat 3 อัน ที่ตัวที่ 3 ใช้ class เดาไม่ได้โดยเจตนา) ─────
function oneCardHtml(opts: {
  invoiceNo: string
  statusLabel: string
  customerName: string
  brand: string
  model: string
  imeiSerial: string // ดิบ "IMEI / SERIAL"
  shopName: string
  shopContact: string
  downPaymentDate: string
  nextDueDate: string
  overdueDays: number
  totalAmountThb: string // เช่น "38,728"
  installmentsTotal: number
  installmentsPaid: number
  installmentsOverdue: number
}): string {
  return `
  <div class="customer-card mb-4">
    <div class="card-header">
      <p class="mb-0 text-muted">เลขที่ใบแจ้งหนี้: ${opts.invoiceNo}</p>
      <span class="badge badge-danger">${opts.statusLabel}</span>
    </div>
    <div class="card-body">
      <div class="row">
        <div class="info-section">
          <div class="section-title">ข้อมูลลูกค้า</div>
          <div class="info-grid">
            <div class="info-item"><div class="info-label">ชื่อลูกค้า</div><div class="info-value">${opts.customerName}</div></div>
            <div class="info-item"><div class="info-label">เลขบัตรประชาชน</div><div class="info-value">1111111111119</div></div>
            <div class="info-item"><div class="info-label">หมายเลขติดต่อ</div><div class="info-value">0800000000</div></div>
          </div>
        </div>
        <div class="info-section">
          <div class="section-title">ข้อมูลสินค้า</div>
          <div class="info-grid">
            <div class="info-item"><div class="info-label">ยี่ห้อสินค้า</div><div class="info-value">${opts.brand}</div></div>
            <div class="info-item"><div class="info-label">รุ่นสินค้า</div><div class="info-value">${opts.model}</div></div>
            <div class="info-item"><div class="info-label">IMEI/Serial</div><div class="info-value">${opts.imeiSerial}</div></div>
          </div>
        </div>
        <div class="info-section">
          <div class="section-title">ข้อมูลร้านค้า</div>
          <div class="info-grid">
            <div class="info-item"><div class="info-label">ชื่อร้าน</div><div class="info-value">${opts.shopName}</div></div>
            <div class="info-item"><div class="info-label">ติดต่อร้าน</div><div class="info-value">${opts.shopContact}</div></div>
          </div>
        </div>
        <div class="info-section">
          <div class="section-title">ข้อมูลการชำระเงิน</div>
          <div class="info-grid">
            <div class="info-item"><div class="info-label">วันที่จ่ายเงินดาวน์</div><div class="info-value">${opts.downPaymentDate}</div></div>
            <div class="info-item">
              <div class="info-label">กำหนดชำระครั้งถัดไป</div>
              <div class="info-value">
                <div class="mb-1">${opts.nextDueDate}</div>
                <span class="payment-status payment-overdue">${opts.overdueDays} days overdue</span>
              </div>
            </div>
            <div class="info-item"><div class="info-label">จำนวนงวดทั้งหมด</div><div class="info-value">${opts.totalAmountThb} THB</div></div>
          </div>
        </div>
      </div>
      <div class="installment-progress mt-4">
        <h6>ความคืบหน้าการชำระเงิน</h6>
        <div class="installment-stat total">
          <div class="stat-value">${opts.installmentsTotal}</div>
          <div class="stat-label">จำนวนงวดทั้งหมด</div>
        </div>
        <div class="installment-stat paid">
          <div class="stat-value">${opts.installmentsPaid}</div>
          <div class="stat-label">จำนวนงวดที่ชำระแล้ว</div>
        </div>
        <div class="installment-stat late-xyz-unknown-class">
          <div class="stat-value">${opts.installmentsOverdue}</div>
          <div class="stat-label">จำนวนงวดที่ค้างชำระ</div>
        </div>
        <div class="progress-text">ความคืบหน้าการชำระ 4%</div>
      </div>
    </div>
  </div>
  `;
}

function foundHtmlWithCards(searchValue: string, cardsHtml: string, count: number): string {
  return `
<html><body>
  <h1>ผลการค้นหาบัญชีดำ</h1>
  <p>ผลการค้นหาสำหรับ: "${searchValue}"</p>
  <div class="summary">${count} พบทั้งหมด</div>
  ${cardsHtml}
</body></html>
`;
}

Deno.test("parsePjBlacklistHtml — not-found (Swal escape \\uXXXX จริง) คืน found:false", () => {
  const result = parsePjBlacklistHtml(NOT_FOUND_HTML);
  assertEquals(result.found, false);
});

Deno.test("parsePjBlacklistHtml — การ์ดเดียว parse ครบทุกฟิลด์ตามโครงจริง (รวม field ที่เคยบั๊ก)", () => {
  const html = foundHtmlWithCards(
    "1111111111119",
    oneCardHtml({
      invoiceNo: "INV-1700000001",
      statusLabel: "หนี้เสีย/ติดตาม",
      customerName: "นางสาวทดสอบ ตัวอย่าง",
      brand: "Apple (iPhone)",
      model: "iPhone 12 Pro Max",
      imeiSerial: "000000000000000 / SERIALXXXX01",
      shopName: "ร้าน วินชัวร์พลัส",
      shopContact: "0800000000",
      downPaymentDate: "06/03/2025",
      nextDueDate: "06/04/2025",
      overdueDays: 540,
      totalAmountThb: "38,728",
      installmentsTotal: 25,
      installmentsPaid: 1,
      installmentsOverdue: 24,
    }),
    1,
  );

  const result = parsePjBlacklistHtml(html);
  assertEquals(result.found, true);
  if (!result.found) return; // narrow (unreachable — assertEquals โยนก่อนหน้านี้ถ้าไม่ตรง)
  assertEquals(result.hits.length, 1);

  const hit = result.hits[0];
  assertEquals(hit.invoiceNo, "INV-1700000001");
  assertEquals(hit.statusLabel, "หนี้เสีย/ติดตาม");
  assertEquals(hit.customerName, "นางสาวทดสอบ ตัวอย่าง");
  assertEquals(hit.brand, "Apple (iPhone)");
  // (เคยบั๊ก v1: model ปนท้ายด้วยข้อความ IMEI เพราะ flatten ทั้งหน้าก่อน parse) ต้องได้ค่าล้วนๆ เท่านั้น
  assertEquals(hit.model, "iPhone 12 Pro Max");
  // (เคยบั๊ก v1: imei_last4 ว่างเปล่า) ต้องตัดเหลือ 4 ตัวท้ายของแต่ละฝั่ง คั่นด้วย " / "
  assertEquals(hit.imeiLast4, "0000 / XX01");
  assertEquals(hit.shopName, "ร้าน วินชัวร์พลัส");
  assertEquals(hit.shopContact, "0800000000");
  assertEquals(hit.downPaymentDate, "06/03/2025");
  // (เคยบั๊ก v1: next_due_date ปนคำว่า "540 days overdue") ต้องเหลือแค่วันที่ล้วนๆ
  assertEquals(hit.nextDueDate, "06/04/2025");
  assertEquals(hit.overdueDays, 540);
  // (เคยบั๊ก v1: installmentsTotal เอาเลข "38,728 THB" ที่ label ผิดมาใช้) ต้องแยกออกจากกันให้ถูก
  assertEquals(hit.totalAmount, 38728);
  assertEquals(hit.installmentsTotal, 25);
  assertEquals(hit.installmentsPaid, 1);
  assertEquals(hit.installmentsOverdue, 24); // (เคยบั๊ก v1: ได้ null เพราะเดา class ตัวที่ 3 ผิด)
});

Deno.test("parsePjBlacklistHtml — 2 การ์ดไม่ปนกัน (กัน regression การ split .customer-card)", () => {
  const card1 = oneCardHtml({
    invoiceNo: "INV-1700000001",
    statusLabel: "หนี้เสีย/ติดตาม",
    customerName: "นายทดสอบ หนึ่ง",
    brand: "Apple (iPhone)",
    model: "iPhone 13",
    imeiSerial: "111111111111111 / SERIALAAAA01",
    shopName: "ร้านทดสอบเอ",
    shopContact: "0811111111",
    downPaymentDate: "01/01/2025",
    nextDueDate: "01/02/2025",
    overdueDays: 30,
    totalAmountThb: "10,000",
    installmentsTotal: 12,
    installmentsPaid: 6,
    installmentsOverdue: 1,
  });
  const card2 = oneCardHtml({
    invoiceNo: "INV-1700000002",
    statusLabel: "ปกติ",
    customerName: "นางสาวทดสอบ สอง",
    brand: "Apple (iPad)",
    model: "iPad Air",
    imeiSerial: "222222222222222 / SERIALBBBB02",
    shopName: "ร้านทดสอบบี",
    shopContact: "0822222222",
    downPaymentDate: "02/02/2025",
    nextDueDate: "02/03/2025",
    overdueDays: 0,
    totalAmountThb: "5,000",
    installmentsTotal: 10,
    installmentsPaid: 10,
    installmentsOverdue: 0,
  });

  const html = foundHtmlWithCards("999999999", card1 + card2, 2);
  const result = parsePjBlacklistHtml(html);
  assertEquals(result.found, true);
  if (!result.found) return;
  assertEquals(result.hits.length, 2);

  const [hit1, hit2] = result.hits;
  assertEquals(hit1.invoiceNo, "INV-1700000001");
  assertEquals(hit1.model, "iPhone 13"); // ต้องไม่ปนกับข้อมูลการ์ดที่ 2
  assertEquals(hit1.imeiLast4, "1111 / AA01");
  assertEquals(hit1.installmentsOverdue, 1);

  assertEquals(hit2.invoiceNo, "INV-1700000002");
  assertEquals(hit2.customerName, "นางสาวทดสอบ สอง");
  assertEquals(hit2.model, "iPad Air");
  assertEquals(hit2.imeiLast4, "2222 / BB02");
  assertEquals(hit2.overdueDays, 0);
  assertEquals(hit2.installmentsOverdue, 0);
});

Deno.test("parsePjBlacklistHtml — HTML แปลกที่ไม่มีทั้ง .customer-card, หัวข้อผลค้นหา, และ marker ไม่พบ ต้อง throw", () => {
  const garbage = "<html><body><h1>เว็บปิดปรับปรุง</h1></body></html>";
  assertThrows(() => parsePjBlacklistHtml(garbage), PjBlacklistParseError);
});
