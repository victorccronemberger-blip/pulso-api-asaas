import { randomUUID } from "node:crypto";
import { resolveOrderStatus } from "./order-status.js";
import { summarizeInstallmentPlan } from "../domain/payment-status.js";

const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
const customerOrder = (order) => order && ({
  id: order.id,
  status: order.status,
  paymentMethod: order.paymentMethod,
  installments: order.installments,
  installmentCents: order.installmentCents,
  subtotalCents: order.subtotalCents,
  discountCents: order.discountCents,
  totalCents: order.totalCents,
  paidCents: order.paidCents ?? 0,
  paidInstallments: order.paidInstallments ?? 0,
  accessGrantedAt: order.accessGrantedAt ?? null,
  couponCode: order.couponCode,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
  lines: (order.lines ?? []).map((line) => ({
    slug: line.slug ?? line.product?.slug,
    title: line.title ?? line.product?.title,
    basePriceCents: line.basePriceCents,
    discountCents: line.discountCents,
    finalPriceCents: line.finalPriceCents,
  })),
});

export function createInMemoryStore({ catalogProducts = [] } = {}) {
  const admins = new Map(); const sessions = new Map(); const customers = new Map(); const customerSessions = new Map(); const customerActionTokens = new Map(); const coupons = new Map(); const orders = new Map(); const installmentsByOrder = new Map(); const enrollments = new Map(); const audits = []; const events = new Set(); const attempts = new Map(); const reservations = new Map(); const settings = new Map(); const products = new Map(catalogProducts.map((product) => [product.slug, structuredClone(product)]));
  let campaign = { activeCouponCode: null, headline: null };

  function findOrderById(orderId) {
    return [...orders.values()].find((order) => order.id === orderId) ?? null;
  }

  function redeemCoupon(order) {
    if (order.couponRedeemed || !order.couponCode) return;
    const coupon = coupons.get(order.couponCode);
    const reservation = [...reservations.entries()].find(([, value]) => value.orderId === `${order.provider}:${order.providerOrderId}`);
    if (!coupon || !reservation) throw new Error("Coupon reservation is missing.");
    coupon.redemptions += 1;
    order.couponRedeemed = true;
    reservations.delete(reservation[0]);
  }

  function reconcileInstallmentOrder(order) {
    const rows = installmentsByOrder.get(order.id) ?? [];
    const summary = summarizeInstallmentPlan(rows, order.installments);
    order.status = summary.status;
    order.paidCents = summary.paidCents;
    order.paidInstallments = summary.paidInstallments;
    if (summary.paidInstallments > 0) {
      order.accessGrantedAt ??= now();
      redeemCoupon(order);
    }
    order.updatedAt = now();
    return summary;
  }
  return {
    async ensureSchema() {}, async close() {},
    async listCatalogProducts({ activeOnly = true } = {}) { return copy([...products.values()].filter((product) => !activeOnly || product.active !== false).sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || String(a.title).localeCompare(String(b.title)))); },
    async countAdmins() { return admins.size; }, async getAdminByEmail(email) { return copy(admins.get(email) ?? null); },
    async createAdmin(admin) { const value = { id: randomUUID(), ...admin, createdAt: now() }; admins.set(value.email, value); return copy(value); },
    async createSession(session) { sessions.set(session.tokenHash, { ...session, id: randomUUID() }); },
    async getSession(tokenHash) { const item = sessions.get(tokenHash); if (!item || item.expiresAt < Date.now()) return null; const admin = [...admins.values()].find((row) => row.id === item.adminId); return admin ? copy({ ...item, admin }) : null; },
    async revokeSession(tokenHash) { sessions.delete(tokenHash); },
    async getCustomerByEmail(email) { return copy(customers.get(email) ?? null); },
    async getCustomerById(customerId) { return copy([...customers.values()].find((customer) => customer.id === customerId) ?? null); },
    async listCustomers({ limit = 100 } = {}) {
      return copy([...customers.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((customer) => ({
          id: customer.id,
          email: customer.email,
          displayName: customer.displayName,
          mobilePhone: customer.mobilePhone,
          documentLast4: customer.documentLast4,
          emailVerifiedAt: customer.emailVerifiedAt,
          createdAt: customer.createdAt,
          activationCount: [...enrollments.values()].filter(
            (enrollment) => enrollment.customerId === customer.id && enrollment.status === "confirmed",
          ).length,
        })));
    },
    async createCustomer(customer) { const value = { id: randomUUID(), mobilePhone: null, documentLast4: null, emailVerifiedAt: null, ...customer, createdAt: now() }; customers.set(value.email, value); return copy(value); },
    async updateCustomerProfile(customerId, profile) { const customer = [...customers.values()].find((item) => item.id === customerId); if (!customer) return null; if (profile.displayName !== undefined) customer.displayName = profile.displayName; if (profile.mobilePhone !== undefined) customer.mobilePhone = profile.mobilePhone; if (profile.documentLast4 !== undefined) customer.documentLast4 = profile.documentLast4; return copy(customer); },
    async updateCustomerPassword(customerId, credentials) { const customer = [...customers.values()].find((item) => item.id === customerId); if (!customer) return false; customer.passwordSalt = credentials.passwordSalt; customer.passwordHash = credentials.passwordHash; return true; },
    async markCustomerEmailVerified(customerId) { const customer = [...customers.values()].find((item) => item.id === customerId); if (!customer) return null; customer.emailVerifiedAt ??= now(); return copy(customer); },
    async createCustomerActionToken(value) { for (const [key, item] of customerActionTokens) if (item.customerId === value.customerId && item.kind === value.kind) customerActionTokens.delete(key); customerActionTokens.set(value.tokenHash, { ...value, createdAt: now() }); },
    async consumeCustomerActionToken(value) { const item = customerActionTokens.get(value.tokenHash); if (!item || item.kind !== value.kind || item.expiresAt <= Date.now()) return null; customerActionTokens.delete(value.tokenHash); return copy(item); },
    async createCustomerSession(session) { customerSessions.set(session.tokenHash, { ...session, id: randomUUID() }); },
    async getCustomerSession(tokenHash) { const item = customerSessions.get(tokenHash); if (!item || item.expiresAt < Date.now()) return null; const customer = [...customers.values()].find((row) => row.id === item.customerId); return customer ? copy({ ...item, customer }) : null; },
    async revokeCustomerSession(tokenHash) { customerSessions.delete(tokenHash); },
    async revokeCustomerSessions(customerId) { for (const [key, session] of customerSessions) if (session.customerId === customerId) customerSessions.delete(key); },
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
    async createOrder(order) { const providerKey = `${order.provider}:${order.providerOrderId}`; const reservation = order.checkoutAttemptKey ? reservations.get(order.checkoutAttemptKey) : null; if (order.checkoutAttemptKey && !reservation) throw new Error("Coupon reservation is missing."); let existingKey = providerKey; let existing = orders.get(providerKey); if (!existing && order.providerGroupId) { const match = [...orders.entries()].find(([, candidate]) => candidate.provider === order.provider && candidate.providerGroupId === order.providerGroupId); if (match) [existingKey, existing] = match; } const status = resolveOrderStatus(existing?.status, order.status); const value = { ...existing, id: existing?.id ?? randomUUID(), ...order, status, paidCents: (existing?.paidCents ?? 0) || (status === "paid" ? order.totalCents : 0), paidInstallments: (existing?.paidInstallments ?? 0) || (status === "paid" ? 1 : 0), accessGrantedAt: existing?.accessGrantedAt ?? (status === "paid" ? now() : null), createdAt: existing?.createdAt ?? now(), updatedAt: now(), couponRedeemed: existing?.couponRedeemed ?? false }; if (existing && existingKey !== providerKey) orders.delete(existingKey); orders.set(providerKey, value); if (reservation) reservation.orderId = providerKey; if (value.status === "paid") redeemCoupon(value); return copy(value); },
    async updateOrderFromWebhook({ provider, providerOrderId, providerGroupId, status, eventId }) { if (eventId && events.has(eventId)) return { duplicate: true }; const providerKey = `${provider}:${providerOrderId}`; let storedKey = providerKey; let order = orders.get(providerKey); if (!order && providerGroupId) { const match = [...orders.entries()].find(([, candidate]) => candidate.provider === provider && candidate.providerGroupId === providerGroupId); if (match) [storedKey, order] = match; } const previousStatus = order?.status ?? null; if (!order) { order = { id: randomUUID(), provider, providerOrderId, providerGroupId: providerGroupId ?? null, status: "processing", buyerEmail: null, buyerCpf: null, buyerName: null, buyerPhone: null, couponCode: null, subtotalCents: 0, discountCents: 0, totalCents: 0, paidCents: 0, paidInstallments: 0, accessGrantedAt: null, lines: [], createdAt: now(), updatedAt: now(), couponRedeemed: false, reconciled: true }; orders.set(providerKey, order); storedKey = providerKey; } if (eventId) events.add(eventId); order.status = resolveOrderStatus(order.status, status); order.updatedAt = now(); if (order.status === "paid") { order.paidCents = order.totalCents; order.paidInstallments = 1; order.accessGrantedAt ??= now(); } const reservation = [...reservations.entries()].find(([, value]) => value.orderId === storedKey); if (order.status === "paid" && !order.couponRedeemed && order.couponCode) { const coupon = coupons.get(order.couponCode); if (!coupon || !reservation) throw new Error("Coupon reservation is missing."); coupon.redemptions += 1; order.couponRedeemed = true; reservations.delete(reservation[0]); } if (["failed", "refunded", "chargeback"].includes(order.status) && reservation) reservations.delete(reservation[0]); return { ...copy(order), previousStatus }; },
    async replacePaymentInstallments(orderId, providerGroupId, rows) {
      const order = findOrderById(orderId);
      if (!order || order.providerGroupId !== providerGroupId) throw new Error("Installment order was not found.");
      installmentsByOrder.set(orderId, rows.map((row) => ({ ...row, orderId })));
      reconcileInstallmentOrder(order);
    },
    async listPaymentInstallments(orderId) { return copy(installmentsByOrder.get(orderId) ?? []); },
    async updatePaymentInstallmentFromWebhook({ provider, providerOrderId, providerGroupId, installment, eventId }) {
      if (eventId && events.has(eventId)) return { duplicate: true };
      const order = [...orders.values()].find((candidate) => candidate.provider === provider && (candidate.providerOrderId === providerOrderId || candidate.providerGroupId === providerGroupId));
      if (!order) return this.updateOrderFromWebhook({ provider, providerOrderId, providerGroupId, status: installment.status, eventId });
      if (eventId) events.add(eventId);
      const rows = installmentsByOrder.get(order.id) ?? [];
      const position = rows.findIndex((row) => row.providerPaymentId === installment.providerPaymentId || row.number === installment.number);
      const value = { ...installment, orderId: order.id, providerGroupId };
      if (position >= 0) rows[position] = value; else rows.push(value);
      installmentsByOrder.set(order.id, rows);
      const previousStatus = order.status;
      const hadAccess = Boolean(order.accessGrantedAt);
      reconcileInstallmentOrder(order);
      return { id: order.id, status: order.status, previousStatus, accessGrantedNow: !hadAccess && Boolean(order.accessGrantedAt) };
    },
    async getSetting(key) { return settings.has(key) ? copy(settings.get(key)) : null; },
    async setSetting(key, value) { settings.set(key, copy(value ?? null)); },
    async updateProductCohortBySourceTag(sourceTag, cohort) {
      for (const product of products.values()) {
        if (product.sourceTag === sourceTag) product.cohort = String(cohort);
      }
    },
    async getCampaign() { return copy(campaign); }, async saveCampaign(next) { campaign = { ...campaign, ...next }; return copy(campaign); },
    async audit(entry) { audits.unshift({ id: randomUUID(), ...entry, createdAt: now() }); },
    async overview() {
      const values = [...orders.values()];
      const paid = values.filter((order) => order.status === "paid" || order.paidCents > 0);
      const paidRevenueCents = paid.reduce((sum, order) => sum + (order.paidCents ?? 0), 0);
      return {
        orders: values.length,
        paidOrders: paid.length,
        openOrders: values.filter((order) => ["created", "open", "processing", "partially_paid", "overdue"].includes(order.status)).length,
        failedOrders: values.filter((order) => ["failed", "chargeback"].includes(order.status)).length,
        refundedOrders: values.filter((order) => order.status === "refunded").length,
        grossRevenueCents: paid.reduce((sum, order) => sum + Math.round(order.subtotalCents * order.paidCents / order.totalCents), 0),
        discountsCents: paid.reduce((sum, order) => sum + Math.round(order.discountCents * order.paidCents / order.totalCents), 0),
        paidRevenueCents,
        averageTicketCents: paid.length ? Math.round(paidRevenueCents / paid.length) : 0,
      };
    },
    async finance() {
      const aggregate = new Map();
      for (const order of orders.values()) if (order.paidCents > 0) {
        const day = order.updatedAt.slice(0, 10);
        const current = aggregate.get(day) ?? { day, orders: 0, grossCents: 0, discountCents: 0, totalCents: 0 };
        current.orders += 1;
        current.grossCents += Math.round(order.subtotalCents * order.paidCents / order.totalCents);
        current.discountCents += Math.round(order.discountCents * order.paidCents / order.totalCents);
        current.totalCents += order.paidCents;
        aggregate.set(day, current);
      }
      return [...aggregate.values()].sort((left, right) => left.day.localeCompare(right.day));
    },
    async listOrders({ limit = 50, status } = {}) { return copy([...orders.values()].filter((o) => !status || o.status === status).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)); },
    async listCustomerOrders(customerId, { limit = 50 } = {}) { return copy([...orders.values()].filter((order) => order.customerId === customerId).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(customerOrder)); },
    async getCustomerOrder(customerId, orderId) { return copy(customerOrder([...orders.values()].find((order) => order.customerId === customerId && order.id === orderId) ?? null)); },
    async getCustomerOrderByProviderOrderId(customerId, provider, providerOrderId) { return copy([...orders.values()].find((order) => order.customerId === customerId && order.provider === provider && order.providerOrderId === providerOrderId) ?? null); },
    async getCustomerOrderForSync(customerId, orderId) { const order = findOrderById(orderId); return order?.customerId === customerId ? copy({ id:order.id,status:order.status,paymentMethod:order.paymentMethod,installments:order.installments,providerGroupId:order.providerGroupId }) : null; },
    async getCustomerBuyerProfile(customerId) {
      const candidates = [...orders.values()]
        .filter((order) => order.customerId === customerId && order.buyerCpf)
        .sort((a, b) => Number(b.status === "paid" || (b.paidCents ?? 0) > 0) - Number(a.status === "paid" || (a.paidCents ?? 0) > 0) || b.updatedAt.localeCompare(a.updatedAt));
      const order = candidates[0];
      return order ? { email: order.buyerEmail ?? null, fullName: order.buyerName ?? null, documentNumber: order.buyerCpf, mobilePhone: order.buyerPhone ?? null, birthDate: order.buyerBirthDate ?? null, address: order.buyerAddress ?? null } : null;
    },
    async listAudit({ limit = 100 } = {}) { return copy(audits.slice(0, limit)); },
    async getOrderWithItems(orderId) { const order = findOrderById(orderId); if (!order) return null; return { id: order.id, customerId: order.customerId ?? null, buyerEmail: order.buyerEmail ?? null, buyerCpf: order.buyerCpf ?? null, buyerName: order.buyerName ?? null, buyerPhone: order.buyerPhone ?? null, buyerBirthDate: order.buyerBirthDate ?? null, buyerAddress: order.buyerAddress ?? null, items: (order.lines ?? []).map((line, index) => ({ id: index + 1, courseSlug: line.slug ?? line.product?.slug, title: line.title ?? line.product?.title })) }; },
    async createEnrollmentJob(job) { for (const e of enrollments.values()) if ((job.customerId && e.customerId === job.customerId && e.courseSlug === job.courseSlug && !["failed", "not_created"].includes(e.status)) || (job.orderId && e.orderId === job.orderId && e.courseSlug === job.courseSlug)) return null; const value = { id: randomUUID(), orderId: job.orderId ?? null, orderItemId: job.orderItemId ?? null, customerId: job.customerId ?? null, courseSlug: job.courseSlug, sourceTag: job.sourceTag, status: "queued", attempts: 0, idTurma: null, turmaSelection: null, userId: null, result: null, error: null, buyerEmail: job.buyerEmail ?? null, buyerCpf: job.buyerCpf ?? null, buyerName: job.buyerName ?? null, buyerBirthDate: job.buyerBirthDate ?? null, buyerAddress: job.buyerAddress ?? null, buyerPhone: job.buyerPhone ?? null, createdAt: now(), updatedAt: now() }; enrollments.set(value.id, value); return value.id; },
    async listPendingEnrollmentJobs() { return copy([...enrollments.values()].filter((e) => e.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))); },
    async claimEnrollmentJob(enrollmentId) { const e = enrollments.get(enrollmentId); if (!e || e.status !== "queued") return false; e.status = "processing"; e.attempts += 1; e.updatedAt = now(); return true; },
    async finishEnrollmentJob(enrollmentId, patch) { const e = enrollments.get(enrollmentId); if (!e) return; e.status = patch.status; e.idTurma = patch.idTurma ?? null; e.turmaSelection = patch.turmaSelection ?? null; e.userId = patch.userId ?? null; e.result = patch.result ?? null; e.error = patch.error ?? null; e.updatedAt = now(); },
    async requeueEnrollmentJob(enrollmentId) { const e = enrollments.get(enrollmentId); if (!e || !["failed", "not_created", "pending"].includes(e.status)) return false; e.status = "queued"; e.error = null; e.updatedAt = now(); return true; },
    async recoverStaleEnrollments(maxAgeMinutes = 45) { const cutoff = Date.now() - maxAgeMinutes * 60_000; let count = 0; for (const e of enrollments.values()) if (e.status === "processing" && Date.parse(e.updatedAt) < cutoff) { e.status = "queued"; count += 1; } return count; },
    async touchEnrollmentJob(enrollmentId) { const e = enrollments.get(enrollmentId); if (e) e.updatedAt = now(); },
    async listEnrollmentJobs({ limit = 50, status } = {}) { return copy([...enrollments.values()].filter((e) => !status || e.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)); },
    async getEnrollmentJob(enrollmentId) { return copy(enrollments.get(enrollmentId) ?? null); },
  };
}
