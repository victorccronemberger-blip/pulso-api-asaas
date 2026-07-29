import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/admin/in-memory-store.js";
import { resolveOrderStatus } from "../src/admin/order-status.js";

async function api(context) {
  const store = createInMemoryStore();
  const { app, ready } = createApp({
    PORT: "3101", PUBLIC_ORIGIN: "https://pulso.cyara.com.br", NODE_ENV: "test",
    ADMIN_BOOTSTRAP_TOKEN: "only-for-this-test-bootstrap", SESSION_PEPPER: "test-pepper-not-production",
  }, { store });
  await ready;
  const server = app.listen(0, "127.0.0.1"); context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

function cookieHeader(response) {
  const values = response.headers.getSetCookie();
  return values.map((value) => value.split(";")[0]).join("; ");
}

test("bootstraps an administrator, issues an HttpOnly session, and enforces CSRF", async (context) => {
  const { base } = await api(context);
  const bootstrap = await fetch(`${base}/v1/admin/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "only-for-this-test-bootstrap", email: "admin@pulso.test", password: "long-and-unique-password" }) });
  assert.equal(bootstrap.status, 201);
  const login = await fetch(`${base}/v1/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@pulso.test", password: "long-and-unique-password" }) });
  assert.equal(login.status, 200);
  const cookies = cookieHeader(login);
  assert.match(login.headers.getSetCookie().join("\n"), /__Host-pulso_admin=.*HttpOnly/);
  const csrf = /pulso_admin_csrf=([^;]+)/.exec(cookies)?.[1]; assert.ok(csrf);
  const denied = await fetch(`${base}/v1/admin/coupons`, { method: "POST", headers: { "content-type": "application/json", cookie: cookies }, body: JSON.stringify({ code: "VERAO", discountBps: 1200 }) });
  assert.equal(denied.status, 403);
  const created = await fetch(`${base}/v1/admin/coupons`, { method: "POST", headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": decodeURIComponent(csrf) }, body: JSON.stringify({ code: "VERAO", discountBps: 1200, maxRedemptions: 2, productSlugs: ["novo-cpa"] }) });
  assert.equal(created.status, 201);
});

test("quotes only eligible coupons and publishes the campaign without leaking administration", async (context) => {
  const { base, store } = await api(context);
  await store.saveCoupon({ code: "CPA20", discountBps: 2000, active: true, startsAt: null, endsAt: null, maxRedemptions: 1, productSlugs: ["novo-cpa"] });
  await store.saveCampaign({ activeCouponCode: "CPA20", headline: "Condi\u00e7\u00e3o de lan\u00e7amento" });
  const quote = await fetch(`${base}/v1/public/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: "CPA20" }) });
  assert.equal(quote.status, 200); assert.equal((await quote.json()).discountCents, 15_000);
  const scopedOut = await fetch(`${base}/v1/public/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs: ["cpro-i"], couponCode: "CPA20" }) });
  assert.equal(scopedOut.status, 400);
  const campaign = await fetch(`${base}/v1/public/campaign`);
  assert.deepEqual(await campaign.json(), { campaign: { activeCouponCode: "CPA20", discountBps: 2000, headline: "Condi\u00e7\u00e3o de lan\u00e7amento" } });
});

test("persists checkout orders and applies coupon redemption once on an Asaas webhook", async (context) => {
  const { store } = await api(context);
  const attemptKey = "a0000000-0000-4000-8000-000000000055";
  await store.saveCoupon({ code: "TEST35", discountBps: 3500, active: true, startsAt: null, endsAt: null, maxRedemptions: null, productSlugs: [] });
  await store.reserveCoupon("TEST35", attemptKey, []);
  await store.createOrder({ provider: "asaas", providerOrderId: "pay_55", checkoutAttemptKey: attemptKey, status: "open", buyerEmail: "buyer@example.test", couponCode: "TEST35", subtotalCents: 1000, discountCents: 350, totalCents: 650, lines: [] });
  await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_55", status: "paid", eventId: "paid-55" });
  await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_55", status: "paid", eventId: "paid-55" });
  await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_55", status: "processing", eventId: "late-processing-55" });
  const coupon = await store.getCoupon("TEST35");
  assert.equal(coupon.redemptions, 1);
  assert.deepEqual(await store.overview(), {
    orders: 1,
    paidOrders: 1,
    openOrders: 0,
    failedOrders: 0,
    refundedOrders: 0,
    grossRevenueCents: 1_000,
    discountsCents: 350,
    paidRevenueCents: 650,
    averageTicketCents: 650,
  });
});

test("store idempotency is atomic and a one-use coupon cannot be reserved twice", async () => {
  const store = createInMemoryStore();
  const [first, duplicate, conflict] = await Promise.all([
    store.beginCheckoutAttempt("8e616e72-6d03-46f1-9d6a-1ebae6097c70", "a".repeat(64)),
    store.beginCheckoutAttempt("8e616e72-6d03-46f1-9d6a-1ebae6097c70", "a".repeat(64)),
    store.beginCheckoutAttempt("8e616e72-6d03-46f1-9d6a-1ebae6097c70", "b".repeat(64)),
  ]);
  assert.equal(first.kind, "new"); assert.equal(duplicate.kind, "pending"); assert.equal(conflict.kind, "conflict");
  await store.saveCoupon({ code: "UNICO", discountBps: 1000, active: true, startsAt: null, endsAt: null, maxRedemptions: 1, productSlugs: [] });
  const reservations = await Promise.all([
    store.reserveCoupon("UNICO", "a0000000-0000-4000-8000-000000000001"),
    store.reserveCoupon("UNICO", "a0000000-0000-4000-8000-000000000002"),
  ]);
  assert.equal(reservations.filter(Boolean).length, 1);
});

test("production refuses the non-persistent fallback", () => {
  assert.throws(() => createApp({ NODE_ENV: "production", PORT: "3102" }), /MYSQL_URL is required/);
});

test("redirects the retired API admin console to the single frontend panel", async (context) => {
  const { base } = await api(context);
  const response = await fetch(`${base}/admin/`, { redirect: "manual" });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://pulso.cyara.com.br/admin/");

  const protectedApi = await fetch(`${base}/v1/admin/session`);
  assert.equal(protectedApi.status, 401);
});

test("reconciles a paid webhook that arrives before local order enrichment", async () => {
  const store = createInMemoryStore();
  const attemptKey = "a0000000-0000-4000-8000-000000000088";
  await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: "pay_88", status: "paid", eventId: "paid-before-order-88" });
  await store.saveCoupon({ code: "TEST35", discountBps: 3500, active: true, startsAt: null, endsAt: null, maxRedemptions: null, productSlugs: [] });
  await store.reserveCoupon("TEST35", attemptKey, []);
  await store.createOrder({
    provider: "asaas",
    providerOrderId: "pay_88",
    checkoutAttemptKey: attemptKey,
    status: "created",
    buyerEmail: "buyer@example.test",
    couponCode: "TEST35",
    subtotalCents: 1000,
    discountCents: 350,
    totalCents: 650,
    lines: [],
  });
  const coupon = await store.getCoupon("TEST35");
  assert.equal(coupon.redemptions, 1);
  assert.equal((await store.overview()).paidOrders, 1);
});

test("keeps pending checkout attempts fail-closed and allows only explicit safe abandonment", async () => {
  const store = createInMemoryStore();
  const key = "a0000000-0000-4000-8000-000000000099";
  assert.equal((await store.beginCheckoutAttempt(key, "a".repeat(64))).kind, "new");
  assert.equal((await store.beginCheckoutAttempt(key, "a".repeat(64))).kind, "pending");
  await store.abandonCheckoutAttempt(key);
  assert.equal((await store.beginCheckoutAttempt(key, "a".repeat(64))).kind, "new");
});

test("buyer profile carries birth date and full address from the paid order", async () => {
  const store = createInMemoryStore();
  const customer = await store.createCustomer({ email: "perfil@example.test", displayName: "Perfil Completo", passwordSalt: "salt", passwordHash: "hash" });
  const address = { postCode: "13000000", street: "Rua das Palmas", number: "45", complement: "Apto 71", district: "Jardim", city: "Campinas", state: "SP" };
  await store.createOrder({
    provider: "asaas",
    providerOrderId: "pay_profile1",
    customerId: customer.id,
    status: "paid",
    buyerEmail: "perfil@example.test",
    buyerCpf: "19100000000",
    buyerName: "Perfil Completo",
    buyerPhone: "11988887777",
    buyerBirthDate: "1985-05-10",
    buyerAddress: address,
    subtotalCents: 75_000,
    discountCents: 0,
    totalCents: 75_000,
    lines: [],
  });
  const profile = await store.getCustomerBuyerProfile(customer.id);
  assert.deepEqual(profile, {
    email: "perfil@example.test",
    fullName: "Perfil Completo",
    documentNumber: "19100000000",
    mobilePhone: "11988887777",
    birthDate: "1985-05-10",
    address,
  });
});

test("order status cannot regress when gateway events arrive out of order", () => {
  assert.equal(resolveOrderStatus("processing", "created"), "processing");
  assert.equal(resolveOrderStatus("failed", "open"), "failed");
  assert.equal(resolveOrderStatus("failed", "paid"), "paid");
  assert.equal(resolveOrderStatus("paid", "processing"), "paid");
  assert.equal(resolveOrderStatus("paid", "refunded"), "refunded");
});
