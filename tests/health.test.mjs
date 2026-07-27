import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

const enabledEnvironment = {
  APPMAX_ENABLED: "true",
  APPMAX_ENVIRONMENT: "sandbox",
  APPMAX_MERCHANT_CLIENT_ID: "merchant-client-id",
  APPMAX_MERCHANT_CLIENT_SECRET: "merchant-client-secret",
  APPMAX_EXTERNAL_ID: "8623e65e-2ddf-4ec0-87f0-aff3bc26a6aa",
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
    ip: "127.0.0.1",
  };
}

function requestHeaders() {
  return {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  };
}

test("reports a healthy API while keeping checkout disabled without Appmax merchant credentials", async (context) => {
  const origin = await serve(context, { APPMAX_ENABLED: "true" });
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
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    enabled: false,
    provider: "appmax",
    environment: "sandbox",
    externalId: null,
    methods: [],
  });
});

test("rejects checkout creation while Appmax is disabled", async (context) => {
  const origin = await serve(context, { APPMAX_ENABLED: "false" });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: "PULSO35",
      buyer: { ...buyer(), ip: "198.51.100.17" },
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "checkout_unavailable");
});

test("creates a Pix payment from server-authoritative prices", async (context) => {
  const calls = [];
  const appmaxClient = {
    createCustomer: async (payload) => {
      calls.push(["customer", payload]);
      return { data: { customer: { id: 407 } } };
    },
    createOrder: async (payload) => {
      calls.push(["order", payload]);
      return { data: { order: { id: 6001, status: "pendente" } } };
    },
    createPixPayment: async (payload) => {
      calls.push(["pix", payload]);
      return {
        data: {
          order: { id: 6001, status: "pendente" },
          payment: { pix_qrcode: "aW1hZ2U=", pix_emv: "000201PULSO" },
        },
      };
    },
    getInstallments: async () => assert.fail("Pix must not calculate installments"),
  };
  const origin = await serve(context, enabledEnvironment, { appmaxClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa", "simulados-ancord-2026"],
      couponCode: "pulso35",
      clientTotalCents: 1,
      buyer: { ...buyer(), ip: "198.51.100.17" },
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: 6001,
    status: "open",
    method: "pix",
    totalCents: 125_255,
    pix: { qrCodeBase64: "aW1hZ2U=", emv: "000201PULSO" },
  });
  assert.equal(calls[1][0], "order");
  assert.equal(calls[0][1].ip, "127.0.0.1");
  assert.notEqual(calls[0][1].ip, "198.51.100.17");
  assert.equal(calls[1][1].products[0].unit_value, 97_305);
  assert.equal(calls[1][1].products[1].unit_value, 27_950);
  assert.equal(calls[2][1].payment_data.pix.document_number, "19100000000");
});

test("tokenized card checkout applies ten interest-free installments without receiving raw card data", async (context) => {
  const calls = [];
  const appmaxClient = {
    getInstallments: async () => assert.fail("Interest-free checkout must not add provider interest"),
    createCustomer: async (payload) => {
      calls.push(["customer", payload]);
      return { data: { customer: { id: 407 } } };
    },
    createOrder: async (payload) => {
      calls.push(["order", payload]);
      return { data: { order: { id: 6002, status: "pendente" } } };
    },
    createCardPayment: async (payload) => {
      calls.push(["card", payload]);
      return { data: { order: { id: 6002, status: "autorizado" }, payment: { installments: 10 } } };
    },
  };
  const origin = await serve(context, enabledEnvironment, { appmaxClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: "PULSO35",
      buyer: buyer(),
      payment: {
        method: "credit_card",
        token: "422146c7523a46119d6073ea56193913",
        holderName: "Victor Cronemberger",
        installments: 10,
      },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: 6002,
    status: "processing",
    method: "credit_card",
    installments: 10,
    totalCents: 97_305,
  });
  const order = calls.find(([name]) => name === "order")[1];
  assert.equal("products_value" in order, false);
  assert.equal(order.products[0].unit_value, 97_305);
  const card = calls.find(([name]) => name === "card")[1];
  assert.equal(card.payment_data.credit_card.token, "422146c7523a46119d6073ea56193913");
  assert.equal(card.payment_data.credit_card.installments, 10);
  assert.equal(JSON.stringify(card).includes("number"), true);
  assert.equal(JSON.stringify(card).includes("cvv"), false);
});

test("returns ten server-authoritative interest-free installment options", async (context) => {
  const appmaxClient = {
    getInstallments: async () => assert.fail("Interest-free options are owned by the store"),
  };
  const origin = await serve(context, enabledEnvironment, { appmaxClient });
  const response = await fetch(`${origin}/v1/checkout/installments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: "PULSO35" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    baseTotalCents: 97_305,
    maximumInstallments: 10,
    interestFree: true,
    installments: [
      { number: 1, totalCents: 97_305, installmentCents: 97_305, interestFree: true },
      { number: 2, totalCents: 97_305, installmentCents: 48_653, interestFree: true },
      { number: 3, totalCents: 97_305, installmentCents: 32_435, interestFree: true },
      { number: 4, totalCents: 97_305, installmentCents: 24_327, interestFree: true },
      { number: 5, totalCents: 97_305, installmentCents: 19_461, interestFree: true },
      { number: 6, totalCents: 97_305, installmentCents: 16_218, interestFree: true },
      { number: 7, totalCents: 97_305, installmentCents: 13_901, interestFree: true },
      { number: 8, totalCents: 97_305, installmentCents: 12_164, interestFree: true },
      { number: 9, totalCents: 97_305, installmentCents: 10_812, interestFree: true },
      { number: 10, totalCents: 97_305, installmentCents: 9_731, interestFree: true },
    ],
  });
});

test("rejects products, coupons and raw card payloads outside the server contract", async (context) => {
  const appmaxClient = {
    createCustomer: async () => assert.fail("Appmax must not be called"),
    getInstallments: async () => assert.fail("Appmax must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { appmaxClient });

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
        holderName: "Victor",
        installments: 1,
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

test("allows a safe retry with the same idempotency key before an Appmax order exists", async (context) => {
  let customerCalls = 0;
  const appmaxClient = {
    createCustomer: async () => {
      customerCalls += 1;
      if (customerCalls === 1) throw Object.assign(new Error("temporary"), { endpoint: "/v1/customers" });
      return { data: { customer: { id: 409 } } };
    },
    createOrder: async () => ({ data: { order: { id: 6010, status: "pendente" } } }),
    createPixPayment: async () => ({
      data: {
        order: { id: 6010, status: "pendente" },
        payment: { pix_qrcode: "aW1hZ2U=", pix_emv: "000201RETRY" },
      },
    }),
  };
  const origin = await serve(context, enabledEnvironment, { appmaxClient });
  const key = crypto.randomUUID();
  const payload = {
    slugs: ["novo-cpa"],
    couponCode: "PULSO35",
    buyer: buyer(),
    payment: { method: "pix" },
  };
  const first = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 502);
  assert.equal((await first.json()).retryable, true);
  const second = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(payload),
  });
  assert.equal(second.status, 201);
  assert.equal((await second.json()).orderId, 6010);
  assert.equal(customerCalls, 2);
});

test("replays reconciliation instead of duplicating payment after an ambiguous provider failure", async (context) => {
  const calls = { customer: 0, order: 0, pix: 0 };
  const appmaxClient = {
    createCustomer: async () => {
      calls.customer += 1;
      return { data: { customer: { id: 410 } } };
    },
    createOrder: async () => {
      calls.order += 1;
      return { data: { order: { id: 6011, status: "pendente" } } };
    },
    createPixPayment: async () => {
      calls.pix += 1;
      throw Object.assign(new Error("timeout"), { endpoint: "/v1/payments/pix" });
    },
  };
  const origin = await serve(context, enabledEnvironment, { appmaxClient });
  const key = crypto.randomUUID();
  const payload = {
    slugs: ["novo-cpa"],
    couponCode: "PULSO35",
    buyer: buyer(),
    payment: { method: "pix" },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${origin}/v1/checkout/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      orderId: 6011,
      status: "processing",
      method: "pix",
      totalCents: 97_305,
      message: "Pedido recebido e em reconciliação com a Appmax.",
    });
  }
  assert.deepEqual(calls, { customer: 1, order: 1, pix: 1 });
});

test("validates private Appmax installation without exposing merchant credentials", async (context) => {
  const origin = await serve(context, {
    ...enabledEnvironment,
    APPMAX_APP_NUMERICAL_ID: "1234",
  }, { appmaxClient: {} });
  const response = await fetch(`${origin}/v1/integrations/appmax/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: 1234 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    external_id: "8623e65e-2ddf-4ec0-87f0-aff3bc26a6aa",
    alias: "PULSO Bancário",
  });

  const wrongApp = await fetch(`${origin}/v1/integrations/appmax/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: 9999 }),
  });
  assert.equal(wrongApp.status, 403);
});

test("acknowledges Appmax webhooks quickly and verifies order state through the API", async (context) => {
  const verified = [];
  const appmaxClient = {
    getOrder: async (orderId) => {
      verified.push(orderId);
      return { data: { order: { id: orderId, status: "aprovado" } } };
    },
  };
  const origin = await serve(context, {
    ...enabledEnvironment,
    APPMAX_APP_NUMERICAL_ID: "1234",
  }, { appmaxClient });
  const response = await fetch(`${origin}/v1/webhooks/appmax`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: 1234,
      event: "order_paid",
      data: { order_id: 6001 },
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(verified, [6001]);
});

test("returns only a sanitized order status to the storefront", async (context) => {
  const appmaxClient = {
    getOrder: async (orderId) => ({
      data: {
        order: {
          id: Number(orderId),
          status: "aprovado",
          customer: { email: "private@example.com", document_number: "19100000000" },
        },
      },
    }),
  };
  const origin = await serve(context, enabledEnvironment, { appmaxClient });
  const response = await fetch(`${origin}/v1/checkout/orders/6001`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 6001, status: "paid" });
});
