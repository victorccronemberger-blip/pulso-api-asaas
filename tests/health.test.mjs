import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

const enabledEnvironment = {
  ASAAS_ENABLED: "true",
  ASAAS_ENVIRONMENT: "sandbox",
  ASAAS_API_KEY: "$aact_test_key",
  ASAAS_WEBHOOK_TOKEN: "pulso-webhook-token-with-more-than-32-characters",
};

async function serve(context, overrides = {}, dependencies = {}) {
  const { app } = createApp({
    PORT: "3100",
    PUBLIC_ORIGIN: "https://pulso.cyara.com.br",
    ...overrides,
  }, dependencies);
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function buyer() {
  return {
    firstName: "Victor",
    lastName: "Cronemberger",
    email: "victor@example.com",
    phone: "11999999999",
    documentNumber: "19100000000",
  };
}

function requestHeaders(key = crypto.randomUUID()) {
  return {
    "content-type": "application/json",
    "idempotency-key": key,
  };
}

test("reports a healthy API while keeping checkout disabled without Asaas credentials", async (context) => {
  const origin = await serve(context, { ASAAS_ENABLED: "true" });
  const response = await fetch(`${origin}/health`, {
    headers: { origin: "https://pulso.cyara.com.br" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://pulso.cyara.com.br");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "pulso-api",
    database: { status: "ready", error: null },
    capabilities: { checkout: false },
  });

  const status = await fetch(`${origin}/v1/checkout/status`);
  assert.deepEqual(await status.json(), {
    enabled: false,
    provider: "asaas",
    environment: "sandbox",
    methods: [],
    cardMode: "hosted_invoice",
  });
});

test("restores an Asaas key prefix stripped by a managed runtime", () => {
  const { environment } = createApp({
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_API_KEY: "aact_test_key",
  });
  assert.equal(environment.asaasApiKey, "$aact_test_key");
  assert.equal(environment.checkoutEnabled, true);
});

test("creates a Pix charge from server-authoritative prices", async (context) => {
  const calls = [];
  const asaasClient = {
    findCustomersByDocument: async (document) => {
      calls.push(["findCustomer", document]);
      return { data: [] };
    },
    createCustomer: async (payload) => {
      calls.push(["customer", payload]);
      return { id: "cus_pulso407" };
    },
    createPayment: async (payload) => {
      calls.push(["payment", payload]);
      return { id: "pay_pulso6001", status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6001" };
    },
    updatePayment: async (id, payload) => {
      calls.push(["update", id, payload]);
      return { id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6001" };
    },
    getPixQrCode: async (id) => {
      calls.push(["pix", id]);
      return { encodedImage: "aW1hZ2U=", payload: "000201PULSO", expirationDate: "2026-07-29" };
    },
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa", "simulados-ancord-2026"],
      couponCode: "pulso35",
      clientTotalCents: 1,
      buyer: buyer(),
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_pulso6001",
    status: "open",
    method: "pix",
    totalCents: 125_255,
    pix: { qrCodeBase64: "aW1hZ2U=", emv: "000201PULSO", expiresAt: "2026-07-29" },
  });
  const payment = calls.find(([name]) => name === "payment")[1];
  assert.equal(payment.billingType, "PIX");
  assert.equal(payment.value, 1252.55);
  assert.match(payment.externalReference, /^pulso:/);
  assert.equal(calls.find(([name]) => name === "update")[2].callback.successUrl, "https://pulso.cyara.com.br/checkout/sucesso/?order_id=pay_pulso6001");
});

test("creates a ten-installment hosted Asaas invoice without receiving card data", async (context) => {
  const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_existing407" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => {
      calls.push(payload);
      return { id: "pay_pulso6002", status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6002" };
    },
    updatePayment: async (id) => ({ id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6002" }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: "PULSO35",
      buyer: buyer(),
      payment: { method: "credit_card", installments: 10 },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_pulso6002",
    status: "open",
    method: "credit_card",
    installments: 10,
    totalCents: 97_305,
    redirectUrl: "https://sandbox.asaas.com/i/6002",
  });
  assert.equal(calls[0].billingType, "CREDIT_CARD");
  assert.equal(calls[0].installmentCount, 10);
  assert.equal(calls[0].totalValue, 973.05);
  assert.equal("value" in calls[0], false);
  assert.equal(JSON.stringify(calls[0]).includes("creditCard"), false);
  assert.equal(JSON.stringify(calls[0]).includes("cvv"), false);
});

test("returns ten server-authoritative interest-free installment options", async (context) => {
  const origin = await serve(context, enabledEnvironment, { asaasClient: {} });
  const response = await fetch(`${origin}/v1/checkout/installments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: "PULSO35" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.maximumInstallments, 10);
  assert.equal(result.interestFree, true);
  assert.equal(result.installments.length, 10);
  assert.deepEqual(result.installments[9], {
    number: 10,
    totalCents: 97_305,
    installmentCents: 9_731,
    interestFree: true,
  });
});

test("rejects raw card fields and invalid catalog data before calling Asaas", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  for (const payload of [
    { slugs: ["produto-inventado"], couponCode: null, buyer: buyer(), payment: { method: "pix" } },
    { slugs: ["novo-cpa"], couponCode: "DESCONTO100", buyer: buyer(), payment: { method: "pix" } },
    {
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: buyer(),
      payment: {
        method: "credit_card",
        number: "4000000000000010",
        cvv: "123",
        installments: 0,
      },
    },
  ]) {
    const response = await fetch(`${origin}/v1/checkout/orders`, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }
});

test("allows a safe retry with the same idempotency key before an Asaas charge exists", async (context) => {
  let customerCalls = 0;
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [] }),
    createCustomer: async () => {
      customerCalls += 1;
      if (customerCalls === 1) throw Object.assign(new Error("temporary"), { retryable: true });
      return { id: "cus_retry409" };
    },
    createPayment: async () => ({ id: "pay_retry6010", status: "PENDING" }),
    updatePayment: async (id) => ({ id, status: "PENDING" }),
    getPixQrCode: async () => ({ encodedImage: "aW1hZ2U=", payload: "000201RETRY" }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const key = crypto.randomUUID();
  const payload = { slugs: ["novo-cpa"], couponCode: "PULSO35", buyer: buyer(), payment: { method: "pix" } };
  const first = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST", headers: requestHeaders(key), body: JSON.stringify(payload),
  });
  assert.equal(first.status, 502);
  const second = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST", headers: requestHeaders(key), body: JSON.stringify(payload),
  });
  assert.equal(second.status, 201);
  assert.equal((await second.json()).orderId, "pay_retry6010");
  assert.equal(customerCalls, 2);
});

test("authenticates and deduplicates Asaas payment webhooks", async (context) => {
  const origin = await serve(context, enabledEnvironment, { asaasClient: {} });
  const event = {
    id: "evt_payment_6001",
    event: "PAYMENT_CONFIRMED",
    payment: {
      id: "pay_pulso6001",
      status: "CONFIRMED",
      externalReference: "pulso:attempt-6001",
    },
  };
  const rejected = await fetch(`${origin}/v1/webhooks/asaas`, {
    method: "POST",
    headers: { "content-type": "application/json", "asaas-access-token": "wrong" },
    body: JSON.stringify(event),
  });
  assert.equal(rejected.status, 401);

  for (const duplicate of [false, true]) {
    const response = await fetch(`${origin}/v1/webhooks/asaas`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "asaas-access-token": enabledEnvironment.ASAAS_WEBHOOK_TOKEN,
      },
      body: JSON.stringify(event),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, duplicate });
  }
});

test("returns only a sanitized payment status to the storefront", async (context) => {
  const asaasClient = {
    getPayment: async (id) => ({
      id,
      status: "CONFIRMED",
      customer: "cus_private",
      creditCard: { creditCardNumber: "8829" },
    }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders/pay_pulso6001`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "pay_pulso6001", status: "paid" });
});
