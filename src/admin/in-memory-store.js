import { randomUUID } from "node:crypto";
import { resolveOrderStatus } from "./order-status.js";

const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);

export function createInMemoryStore() {
  const admins = new Map(); const sessions = new Map(); const coupons = new Map(); const orders = new Map(); const audits = []; const events = new Set(); const attempts = new Map(); const reservations = new Map();
  let campaign = { activeCouponCode: "PULSO35", headline: null };
  coupons.set("PULSO35", { id: randomUUID(), code: "PULSO35", discountBps: 3500, active: true, startsAt: null, endsAt: null, maxRedemptions: null, productSlugs: [], redemptions: 0, createdAt: now(), updatedAt: now() });
  return {
    async ensureSchema() {}, async close() {},
    async countAdmins() { return admins.size; }, async getAdminByEmail(email) { return copy(admins.get(email) ?? null); },
    async createAdmin(admin) { const value = { id: randomUUID(), ...admin, createdAt: now() }; admins.set(value.email, value); return copy(value); },
    async createSession(session) { sessions.set(session.tokenHash, { ...session, id: randomUUID() }); },
    async getSession(tokenHash) { const item = sessions.get(tokenHash); if (!item || item.expiresAt < Date.now()) return null; const admin = [...admins.values()].find((row) => row.id === item.adminId); return admin ? copy({ ...item, admin }) : null; },
    async revokeSession(tokenHash) { sessions.delete(tokenHash); },
    async listCoupons() { return copy([...coupons.values()].sort((a, b) => a.code.localeCompare(b.code))); },
    async getCoupon(code) { return copy(coupons.get(code) ?? null); },
    async saveCoupon(coupon) { const old = coupons.get(coupon.code); const value = { id: old?.id ?? randomUUID(), ...old, ...coupon, redemptions: old?.redemptions ?? 0, createdAt: old?.createdAt ?? now(), updatedAt: now() }; coupons.set(value.code, value); return copy(value); },
    async archiveCoupon(code) { const item = coupons.get(code); if (!item) return false; item.active = false; item.updatedAt = now(); if (campaign.activeCouponCode === code) campaign.activeCouponCode = null; return true; },
    async getEligibleCoupon(code, slugs, at = Date.now()) { const c = coupons.get(code); if (!c || !c.active || (c.startsAt && +new Date(c.startsAt) > at) || (c.endsAt && +new Date(c.endsAt) <= at) || (c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions) || (c.productSlugs.length && !slugs.every((slug) => c.productSlugs.includes(slug)))) return null; return copy(c); },
    async beginCheckoutAttempt(key, fingerprint) { const existing = attempts.get(key); if (existing) { if (existing.response && existing.expiresAt <= Date.now()) attempts.delete(key); else { if (existing.fingerprint !== fingerprint) return { kind: "conflict" }; return existing.response ? { kind: "replay", response: copy(existing.response) } : { kind: "pending" }; } } attempts.set(key, { fingerprint, expiresAt: Number.POSITIVE_INFINITY, response: null }); return { kind: "new" }; },
    async completeCheckoutAttempt(key, response) { const attempt = attempts.get(key); if (attempt) { attempt.response = copy(response); attempt.expiresAt = Date.now() + 24 * 60 * 60_000; } },
    async abandonCheckoutAttempt(key) { const attempt = attempts.get(key); if (attempt && !attempt.response) attempts.delete(key); },
    async reserveCoupon(code, attemptKey, slugs = []) { const c = coupons.get(code); if (!c || (c.productSlugs.length && !slugs.every((slug) => c.productSlugs.includes(slug)))) return null; for (const [key, reservation] of reservations) if (reservation.expiresAt <= Date.now()) reservations.delete(key); const taken = [...reservations.values()].filter((r) => r.code === code).length; if (c.maxRedemptions !== null && c.redemptions + taken >= c.maxRedemptions) return null; reservations.set(attemptKey, { code, expiresAt: Date.now() + 24 * 60 * 60_000, orderId: null }); return copy(c); },
    async releaseCouponReservation(attemptKey) { reservations.delete(attemptKey); },
    async createOrder(order) { const id = String(order.appmaxOrderId); const reservation = order.checkoutAttemptKey ? reservations.get(order.checkoutAttemptKey) : null; if (order.checkoutAttemptKey && !reservation) throw new Error("Coupon reservation is missing."); const existing = orders.get(id); const value = { ...existing, id, ...order, status: resolveOrderStatus(existing?.status, order.status), createdAt: existing?.createdAt ?? now(), updatedAt: now(), couponRedeemed: existing?.couponRedeemed ?? false }; orders.set(id, value); if (reservation) reservation.orderId = id; if (value.status === "paid" && value.couponCode && !value.couponRedeemed) { const coupon = coupons.get(value.couponCode); if (!coupon || !reservation) throw new Error("Coupon reservation is missing."); coupon.redemptions += 1; value.couponRedeemed = true; reservations.delete(order.checkoutAttemptKey); } return copy(value); },
    async updateOrderFromWebhook({ appmaxOrderId, status, eventId }) { if (eventId && events.has(eventId)) return { duplicate: true }; let order = orders.get(String(appmaxOrderId)); if (!order) { order = { id: String(appmaxOrderId), appmaxOrderId, status: "processing", buyerEmail: null, couponCode: null, subtotalCents: 0, discountCents: 0, totalCents: 0, lines: [], createdAt: now(), updatedAt: now(), couponRedeemed: false, reconciled: true }; orders.set(String(appmaxOrderId), order); } if (eventId) events.add(eventId); order.status = resolveOrderStatus(order.status, status); order.updatedAt = now(); const reservation = [...reservations.entries()].find(([, value]) => value.orderId === String(appmaxOrderId)); if (order.status === "paid" && !order.couponRedeemed && order.couponCode) { const coupon = coupons.get(order.couponCode); if (!coupon || !reservation) throw new Error("Coupon reservation is missing."); coupon.redemptions += 1; order.couponRedeemed = true; reservations.delete(reservation[0]); } if (["failed", "refunded", "chargeback"].includes(order.status) && reservation) reservations.delete(reservation[0]); return copy(order); },
    async getCampaign() { return copy(campaign); }, async saveCampaign(next) { campaign = { ...campaign, ...next }; return copy(campaign); },
    async audit(entry) { audits.unshift({ id: randomUUID(), ...entry, createdAt: now() }); },
    async overview() {
      const values = [...orders.values()];
      const paid = values.filter((order) => order.status === "paid");
      const paidRevenueCents = paid.reduce((sum, order) => sum + order.totalCents, 0);
      return {
        orders: values.length,
        paidOrders: paid.length,
        openOrders: values.filter((order) => ["created", "open", "processing"].includes(order.status)).length,
        failedOrders: values.filter((order) => ["failed", "chargeback"].includes(order.status)).length,
        refundedOrders: values.filter((order) => order.status === "refunded").length,
        grossRevenueCents: paid.reduce((sum, order) => sum + order.subtotalCents, 0),
        discountsCents: paid.reduce((sum, order) => sum + order.discountCents, 0),
        paidRevenueCents,
        averageTicketCents: paid.length ? Math.round(paidRevenueCents / paid.length) : 0,
      };
    },
    async finance() {
      const aggregate = new Map();
      for (const order of orders.values()) if (order.status === "paid") {
        const day = order.updatedAt.slice(0, 10);
        const current = aggregate.get(day) ?? { day, orders: 0, grossCents: 0, discountCents: 0, totalCents: 0 };
        current.orders += 1;
        current.grossCents += order.subtotalCents;
        current.discountCents += order.discountCents;
        current.totalCents += order.totalCents;
        aggregate.set(day, current);
      }
      return [...aggregate.values()].sort((left, right) => left.day.localeCompare(right.day));
    },
    async listOrders({ limit = 50, status } = {}) { return copy([...orders.values()].filter((o) => !status || o.status === status).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)); },
    async listAudit({ limit = 100 } = {}) { return copy(audits.slice(0, limit)); },
  };
}
