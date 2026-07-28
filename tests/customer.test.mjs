import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

async function serve(context) {
  const { app, store } = createApp({
    PORT: "3100",
    PUBLIC_ORIGIN: "https://pulso.cyara.com.br",
    SESSION_PEPPER: "customer-test-pepper-with-sufficient-entropy",
  });
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, store };
}

function cookies(response) {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

test("registers a customer, protects the portal, and lists only owned orders", async (context) => {
  const { origin, store } = await serve(context);
  const registration = await fetch(`${origin}/v1/customer/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Cliente PULSO",
      email: "cliente@example.com",
      password: "uma-senha-segura-2026",
    }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json();
  assert.equal(registered.customer.email, "cliente@example.com");
  assert.equal("passwordHash" in registered.customer, false);

  const cookie = cookies(registration);
  const session = await fetch(`${origin}/v1/customer/session`, { headers: { cookie } });
  assert.equal(session.status, 200);

  await store.createOrder({
    provider: "asaas",
    providerOrderId: "pay_customer_001",
    status: "paid",
    buyerEmail: registered.customer.email,
    customerId: registered.customer.id,
    paymentMethod: "credit_card",
    installments: 10,
    installmentCents: 7500,
    subtotalCents: 75000,
    discountCents: 0,
    totalCents: 75000,
    couponCode: null,
    lines: [{
      product: { slug: "novo-cpa", title: "CPA 2026" },
      basePriceCents: 75000,
      discountCents: 0,
      finalPriceCents: 75000,
    }],
  });

  const history = await fetch(`${origin}/v1/customer/orders`, { headers: { cookie } });
  assert.equal(history.status, 200);
  const result = await history.json();
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].paymentMethod, "credit_card");
  assert.equal(result.orders[0].installments, 10);
  assert.equal(result.orders[0].lines[0].slug, "novo-cpa");

  const anonymous = await fetch(`${origin}/v1/customer/orders`);
  assert.equal(anonymous.status, 401);
});

test("rejects duplicate customer registration and invalid login", async (context) => {
  const { origin } = await serve(context);
  const body = JSON.stringify({
    displayName: "Cliente PULSO",
    email: "cliente@example.com",
    password: "uma-senha-segura-2026",
  });
  const first = await fetch(`${origin}/v1/customer/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(first.status, 201);
  const duplicate = await fetch(`${origin}/v1/customer/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(duplicate.status, 409);
  const invalid = await fetch(`${origin}/v1/customer/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cliente@example.com", password: "senha-errada-2026" }),
  });
  assert.equal(invalid.status, 401);
});
