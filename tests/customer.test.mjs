import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

async function serve(context, dependencies = {}) {
  const { app, store } = createApp({
    PORT: "3100",
    PUBLIC_ORIGIN: "https://pulso.cyara.com.br",
    SESSION_PEPPER: "customer-test-pepper-with-sufficient-entropy",
  }, dependencies);
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, store };
}

async function waitForValue(read) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
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

test("updates the customer profile and changes the password with CSRF protection", async (context) => {
  const { origin } = await serve(context);
  const registration = await fetch(`${origin}/v1/customer/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Cliente Inicial",
      email: "perfil@example.com",
      password: "senha-inicial-segura-2026",
    }),
  });
  const registered = await registration.json();
  const cookie = cookies(registration);

  const denied = await fetch(`${origin}/v1/customer/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ displayName: "Cliente Atualizado", mobilePhone: "11999999999" }),
  });
  assert.equal(denied.status, 403);

  const updated = await fetch(`${origin}/v1/customer/profile`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": registered.csrfToken,
    },
    body: JSON.stringify({ displayName: "Cliente Atualizado", mobilePhone: "(11) 99999-9999" }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).customer, {
    ...registered.customer,
    displayName: "Cliente Atualizado",
    mobilePhone: "11999999999",
  });

  const changed = await fetch(`${origin}/v1/customer/password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": registered.csrfToken,
    },
    body: JSON.stringify({
      currentPassword: "senha-inicial-segura-2026",
      newPassword: "senha-nova-bem-segura-2026",
    }),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { changed: true, reauthenticate: true });

  const expiredSession = await fetch(`${origin}/v1/customer/session`, { headers: { cookie } });
  assert.equal(expiredSession.status, 401);
  const oldLogin = await fetch(`${origin}/v1/customer/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "perfil@example.com", password: "senha-inicial-segura-2026" }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${origin}/v1/customer/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "perfil@example.com", password: "senha-nova-bem-segura-2026" }),
  });
  assert.equal(newLogin.status, 200);
});

test("verifies email and resets a forgotten password with single-use tokens", async (context) => {
  let verificationToken;
  let resetToken;
  const customerMailer = {
    available: true,
    async sendEmailVerification(message) {
      verificationToken = message.token;
    },
    async sendPasswordReset(message) {
      resetToken = message.token;
    },
  };
  const { origin } = await serve(context, { customerMailer });
  const registration = await fetch(`${origin}/v1/customer/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Cliente Verificado",
      email: "verificado@example.com",
      password: "senha-inicial-segura-2026",
    }),
  });
  assert.equal(registration.status, 201);
  assert.equal((await registration.json()).customer.emailVerified, false);
  assert.ok(await waitForValue(() => verificationToken));

  const confirmation = await fetch(`${origin}/v1/customer/email-verification/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: verificationToken }),
  });
  assert.equal(confirmation.status, 200);
  assert.equal((await confirmation.json()).customer.emailVerified, true);
  const reusedConfirmation = await fetch(`${origin}/v1/customer/email-verification/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: verificationToken }),
  });
  assert.equal(reusedConfirmation.status, 400);

  const forgot = await fetch(`${origin}/v1/customer/password/forgot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "verificado@example.com" }),
  });
  assert.equal(forgot.status, 202);
  assert.ok(resetToken);

  const reset = await fetch(`${origin}/v1/customer/password/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: resetToken,
      newPassword: "senha-redefinida-segura-2026",
    }),
  });
  assert.equal(reset.status, 200);
  const reusedReset = await fetch(`${origin}/v1/customer/password/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: resetToken,
      newPassword: "outra-senha-redefinida-2026",
    }),
  });
  assert.equal(reusedReset.status, 400);

  const newLogin = await fetch(`${origin}/v1/customer/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "verificado@example.com",
      password: "senha-redefinida-segura-2026",
    }),
  });
  assert.equal(newLogin.status, 200);
});
