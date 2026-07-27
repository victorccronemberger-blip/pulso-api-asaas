import { randomUUID } from "node:crypto";

const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);

export function createInMemoryStore() {
  const admins = new Map(); const sessions = new Map(); const coupons = new Map(); const orders = new Map(); const audits = []; const events = new Set();
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
    async createOrder(order) { const id = String(order.appmaxOrderId); const value = { id, ...order, createdAt: now(), updatedAt: now(), couponRedeemed: false }; orders.set(id, value); return copy(value); },
    async updateOrderFromWebhook({ appmaxOrderId, status, eventId }) { if (eventId && events.has(eventId)) return { duplicate: true }; if (eventId) events.add(eventId); const order = orders.get(String(appmaxOrderId)); if (!order) return { missing: true }; order.status = status; order.updatedAt = now(); if (status === "paid" && !order.couponRedeemed && order.couponCode) { const coupon = coupons.get(order.couponCode); if (coupon && (coupon.maxRedemptions === null || coupon.redemptions < coupon.maxRedemptions)) { coupon.redemptions += 1; order.couponRedeemed = true; } } return copy(order); },
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
