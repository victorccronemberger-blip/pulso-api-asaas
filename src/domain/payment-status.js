const PAID_PROVIDER_STATUSES = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
const OVERDUE_PROVIDER_STATUSES = new Set(["OVERDUE"]);
const REFUNDED_PROVIDER_STATUSES = new Set(["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS"]);
const CHARGEBACK_PROVIDER_STATUSES = new Set([
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "AWAITING_CHARGEBACK_REVERSAL",
]);

export function normalizeAsaasPaymentStatus(value) {
  const status = String(value ?? "").trim().toUpperCase();
  if (PAID_PROVIDER_STATUSES.has(status)) return "paid";
  if (status === "PENDING") return "open";
  if (OVERDUE_PROVIDER_STATUSES.has(status)) return "overdue";
  if (REFUNDED_PROVIDER_STATUSES.has(status)) return "refunded";
  if (CHARGEBACK_PROVIDER_STATUSES.has(status)) return "chargeback";
  return "processing";
}

export function summarizeInstallmentPlan(installments, expectedCount = 0) {
  const rows = Array.isArray(installments) ? installments : [];
  const totalInstallments = Math.max(
    Number(expectedCount) || 0,
    rows.reduce((maximum, row) => Math.max(maximum, Number(row.number) || 0), 0),
    rows.length,
  );
  const paidInstallments = rows.filter((row) => row.status === "paid").length;
  const remainingInstallments = Math.max(0, totalInstallments - paidInstallments);
  const pending = rows
    .filter((row) => row.status !== "paid" && !["refunded", "chargeback"].includes(row.status))
    .sort((left, right) => {
      const dateDifference = String(left.dueDate ?? "").localeCompare(String(right.dueDate ?? ""));
      return dateDifference || Number(left.number) - Number(right.number);
    });
  const next = pending[0] ?? null;

  let status = "open";
  if (totalInstallments > 0 && paidInstallments >= totalInstallments) status = "paid";
  else if (rows.some((row) => row.status === "chargeback")) status = "chargeback";
  else if (rows.some((row) => row.status === "refunded")) status = "refunded";
  else if (rows.some((row) => row.status === "overdue")) status = "overdue";
  else if (paidInstallments > 0) status = "partially_paid";
  else if (rows.some((row) => row.status === "processing")) status = "processing";

  return {
    status,
    totalInstallments,
    paidInstallments,
    remainingInstallments,
    paidCents: rows
      .filter((row) => row.status === "paid")
      .reduce((sum, row) => sum + Number(row.amountCents || 0), 0),
    nextInstallmentNumber: next?.number ?? null,
    nextDueDate: next?.dueDate ?? null,
    nextInstallmentCents: next?.amountCents ?? null,
  };
}

export function customerInstallmentStatus(value, dueDate) {
  if (value === "paid") return "paid";
  if (value === "overdue") return "overdue";
  const due = Date.parse(`${String(dueDate ?? "").slice(0, 10)}T23:59:59Z`);
  if (Number.isFinite(due) && due < Date.now()) return "overdue";
  return "scheduled";
}
