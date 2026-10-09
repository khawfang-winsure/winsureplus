export type PjReceiptPaymentType = "down" | "penalty" | "installment" | "other";

// PJ sends both English codes and Thai display labels in receipt and invoice-item feeds.
// Keep every sync path on the same classification so a label change cannot create drift.
export function classifyPjReceiptPaymentType(value: unknown): PjReceiptPaymentType {
  const type = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (type === "เงินดาวน์" || type === "down" || type === "down_payment") return "down";
  if (type === "ค่าปรับ" || type === "penalty") return "penalty";
  if (type === "ค่างวด" || type === "installment") return "installment";
  return "other";
}
