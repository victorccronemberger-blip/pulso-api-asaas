const coupons = Object.freeze({
  PULSO35: Object.freeze({
    code: "PULSO35",
    discountBps: 3_500,
    version: "pulso35-v1",
  }),
});

export function normalizeCouponCode(value) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  return normalized || null;
}

export function resolveCoupon(value) {
  const code = normalizeCouponCode(value);
  return code ? coupons[code] ?? null : null;
}
