import { randomUUID } from "node:crypto";
import { resolveOrderStatus } from "./order-status.js";

const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
const customerOrder = (order) => order && ({
  ...order,
  lines: (order.lines ?? []).map((line) => ({
    slug: line.slug ?? line.product?.slug,
    title: line.title ?? line.product?.title,
    basePriceCents: line.basePriceCents,
    discountCents: line.discountCents,
    finalPriceCents: line.finalPriceCents,
  })),
});

export function createInMemoryStore() {
  const admins = new Map(); const sessions = new Map(); const customers = new Map(); const customerSessions = new Map(); const coupons = new Map(); const orders = new Map(); const audits = []; const events = new Set(); const attempts = new Map(); const reservations = new Map(); const enrollments = new Map();
  let campaign = { activeCouponCode: null, headline: null };
  return {
    async ensureSchema() {}, async close() {},
    async countAdmins() { return admins.size; }, async getAdminByEmail(email) { return copy(admins.get(email) ?? null); },
    async createAdmin(admin) { const value = { id: randomUUID(), ...admin, createdAt: now() }; admins.set(value.email, value); return copy(value); },
    async createSession(session) { sessions.set(session.tokenHash, { ...session, id: randomUUID() }); },
    async getSession(tokenHash) { const item = sessions.get(tokenHash); if (!item || item.expiresAt < Date.now()) return null; const admin = [...admins.values()].find((row) => row.id === item.adminId); return admin ? copy({ ...item, admin }) : null; },
    async revokeSession(tokenHash) { sessions.delete(tokenHash); },
    async getCustomerByEmail(email) { return copy(customers.get(email) ?? null); },
    async createCustomer(customer) { const value = { id: randomUUID(), mobilePhone: null, documentLast4: null, ...customer, createdAt: now() }; customers.set(value.email, value); return copy(value); },
    async updateCustomerProfile(customerId, profile) { const customer = [...customers.values()].find((item) => item.id === customerId); if (!customer) return null; Object.assign(customer, profile); return copy(customer); },
    async createCustomerSession(session) { customerSessions.set(session.tokenHash, { ...session, id: randomUUID() }); },
    async getCustomerSession(tokenHash) { const item = customerSessions.get(tokenHash); if (!item || item.expiresAt < Date.now()) return null; const customer = [...customers.values()].find((row) => row.id === item.customerId); return customer ? copy({ ...item, customer }) : null; },
    async revokeCustomerSession(tokenHash) { customerSessions.delete(tokenHash); },
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
    async createOrder(order) { const providerKey = `${order.provider}:${order.providerOrderId}`; const reservation = order.checkoutAttemptKey ? reservations.get(order.checkoutAttemptKey) : null; if (order.checkoutAttemptKey && !reservation) throw new Error("Coupon reservation is missing."); const existing = orders.get(providerKey); const value = { ...existing, id: existing?.id ?? randomUUID(), ...order, status: resolveOrderStatus(existing?.status, order.status), createdAt: existing?.createdAt ?? now(), updatedAt: now(), couponRedeemed: existing?.couponRedeemed ?? false }; orders.set(providerKey, value); if (reservation) reservation.orderId = providerKey; if (value.status === "paid" && value.couponCode && !value.couponRedeemed) { const coupon = coupons.get(value.couponCode); if (!coupon || !reservation) throw new Error("Coupon reservation is missing."); coupon.redemptions += 1; value.couponRedeemed = true; reservations.delete(order.checkoutAttemptKey); } return copy(value); },
    async updateOrderFromWebhook({ provider, providerOrderId, providerGroupId, status, eventId }) { if (eventId && events.has(eventId)) return { duplicate: true }; const providerKey = `${provider}:${providerOrderId}`; let storedKey = providerKey; let order = orders.get(providerKey); if (!order && providerGroupId) { const match = [...orders.entries()].find(([, candidate]) => candidate.provider === provider && candidate.providerGroupId === providerGroupId); if (match) [storedKey, order] = match; } const previousStatus = order?.status ?? null; if (!order) { order = { id: randomUUID(), provider, providerOrderId, providerGroupId: providerGroupId ?? null, status: "processing", buyerEmail: null, buyerCpf: null, buyerName: null, buyerPhone: null, couponCode: null, subtotalCents: 0, discountCents: 0, totalCents: 0, lines: [], createdAt: now(), updatedAt: now(), couponRedeemed: false, reconciled: true }; orders.set(providerKey, order); storedKey = providerKey; } if (eventId) events.add(eventId); order.status = resolveOrderStatus(order.status, status); order.updatedAt = now(); const reservation = [...reservations.entries()].find(([, value]) => value.orderId === storedKey); if (order.status === "paid" && !order.couponRedeemed && order.couponCode) { const coupon = coupons.get(order.couponCode); if (!coupon || !reservation) throw new Error("Coupon reservation is missing."); coupon.redemptions += 1; order.couponRedeemed = true; reservations.delete(reservation[0]); } if (["failed", "refunded", "chargeback"].includes(order.status) && reservation) reservations.delete(reservation[0]); return { ...copy(order), previousStatus }; },
    async getOrderWithItems(orderId) { const order = [...orders.values()].find((o) => o.id === orderId); if (!order) return null; return { id: order.id, status: order.status, buyerEmail: order.buyerEmail ?? null, buyerCpf: order.buyerCpf ?? null, buyerName: order.buyerName ?? null, buyerPhone: order.buyerPhone ?? null, items: (order.lines ?? []).map((line, index) => ({ id: index + 1, courseSlug: line.product?.slug ?? line.courseSlug, title: line.product?.title ?? line.title })) }; },
    async createEnrollmentJob(job) { for (const e of enrollments.values()) if (e.orderId === job.orderId && e.courseSlug === job.courseSlug) return null; const value = { id: randomUUID(), orderId: job.orderId, orderItemId: job.orderItemId ?? null, courseSlug: job.courseSlug, sourceTag: job.sourceTag, status: "queued", attempts: 0, idTurma: null, turmaSelection: null, userId: null, result: null, error: null, buyerEmail: job.buyerEmail ?? null, buyerCpf: job.buyerCpf ?? null, buyerName: job.buyerName ?? null, createdAt: now(), updatedAt: now() }; enrollments.set(value.id, value); return value.id; },
    async listPendingEnrollmentJobs() { return copy([...enrollments.values()].filter((e) => e.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))); },
    async claimEnrollmentJob(enrollmentId) { const e = enrollments.get(enrollmentId); if (!e || e.status !== "queued") return false; e.status = "processing"; e.attempts += 1; e.updatedAt = now(); return true; },
    async finishEnrollmentJob(enrollmentId, patch) { const e = enrollments.get(enrollmentId); if (!e) return; e.status = patch.status; e.idTurma = patch.idTurma ?? null; e.turmaSelection = patch.turmaSelection ?? null; e.userId = patch.userId ?? null; e.result = patch.result ?? null; e.error = patch.error ?? null; e.updatedAt = now(); },
    async requeueEnrollmentJob(enrollmentId) { const e = enrollments.get(enrollmentId); if (!e || !["failed", "not_created", "pending"].includes(e.status)) return false; e.status = "queued"; e.error = null; e.updatedAt = now(); return true; },
    async recoverStaleEnrollments() { let count = 0; for (const e of enrollments.values()) if (e.status === "processing") { e.status = "queued"; count += 1; } return count; },
    async listEnrollmentJobs({ limit = 50, status } = {}) { return copy([...enrollments.values()].filter((e) => !status || e.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)); },
    async getEnrollmentJob(enrollmentId) { return copy(enrollments.get(enrollmentId) ?? null); },
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
    async listCustomerOrders(customerId, { limit = 50 } = {}) { return copy([...orders.values()].filter((order) => order.customerId === customerId).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(customerOrder)); },
    async getCustomerOrder(customerId, orderId) { return copy(customerOrder([...orders.values()].find((order) => order.customerId === customerId && order.id === orderId) ?? null)); },
    async listAudit({ limit = 100 } = {}) { return copy(audits.slice(0, limit)); },
  };
}
