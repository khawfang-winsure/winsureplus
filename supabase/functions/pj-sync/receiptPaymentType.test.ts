import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyPjReceiptPaymentType } from "./receiptPaymentType.ts";

const examples: [unknown, "down" | "penalty" | "installment" | "other"][] = [
  ["ค่างวด", "installment"],
  ["ค่าปรับ", "penalty"],
  ["เงินดาวน์", "down"],
  ["installment", "installment"],
  ["penalty", "penalty"],
  ["down_payment", "down"],
  [" INSTALLMENT ", "installment"],
  ["อื่นๆ", "other"],
  ["ค่าธรรมเนียม", "other"],
  ["ค่าธรรมเนียมเปลี่ยนงวด", "other"],
  ["ค่าธรรมเนียมเงินดาวน์", "other"],
  ["ค่าปรับปรุงเอกสาร", "other"],
  ["installment_fee", "other"],
  ["down_adjustment", "other"],
  ["penalty_refund", "other"],
  [null, "other"],
];

for (const [raw, expected] of examples) {
  Deno.test(`PJ receipt type ${String(raw)} is ${expected}`, () => {
    assertEquals(classifyPjReceiptPaymentType(raw), expected);
  });
}
