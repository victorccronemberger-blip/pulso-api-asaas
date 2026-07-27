import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/admin/in-memory-store.js";

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
  assert.equal(quote.status, 200); assert.equal((await quote.json()).discountCents, 29_940);
  const scopedOut = await fetch(`${base}/v1/public/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs: ["cpro-i"], couponCode: "CPA20" }) });
  assert.equal(scopedOut.status, 400);
  const campaign = await fetch(`${base}/v1/public/campaign`);
  assert.deepEqual(await campaign.json(), { campaign: { activeCouponCode: "CPA20", discountBps: 2000, headline: "Condi\u00e7\u00e3o de lan\u00e7amento" } });
});

test("persists checkout orders and applies coupon redemption once on an Appmax webhook", async (context) => {
  const { store } = await api(context);
  await store.createOrder({ appmaxOrderId: 55, status: "open", buyerEmail: "buyer@example.test", couponCode: "PULSO35", subtotalCents: 1000, discountCents: 350, totalCents: 650, lines: [] });
  await store.updateOrderFromWebhook({ appmaxOrderId: 55, status: "paid", eventId: "paid-55" });
  await store.updateOrderFromWebhook({ appmaxOrderId: 55, status: "paid", eventId: "paid-55" });
  const coupon = await store.getCoupon("PULSO35");
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
