import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";

const TRUSTED_TOKEN = "pulso-trusted-checkout-token-2026";

const enabledEnvironment = {
  ASAAS_ENABLED: "true",
  ASAAS_ENVIRONMENT: "sandbox",
  ASAAS_API_KEY: "$aact_test_key",
  ASAAS_WEBHOOK_TOKEN: "pulso-webhook-token-with-more-than-32-characters",
  TRUSTED_CHECKOUT_TOKEN: TRUSTED_TOKEN,
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

function trustedHeaders(key = crypto.randomUUID(), token = TRUSTED_TOKEN) {
  return {
    "content-type": "application/json",
    "idempotency-key": key,
    "x-pulso-trusted-token": token,
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
    cardInstallmentMaximum: 10,
    pixInstallmentMode: "monthly_manual_payment",
    pixInstallmentMaximum: 6,
    pixAutomatic: false,
    minimumPixInstallmentCents: 1000,
    minimumCardInstallmentCents: 500,
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

test("removes a transport escape preserved before an Asaas key", () => {
  const { environment } = createApp({
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_API_KEY: "\\$aact_test_key",
  });
  assert.equal(environment.asaasApiKey, "$aact_test_key");
  assert.equal(environment.checkoutEnabled, true);
});

test("rejects order creation without the trusted frontend token", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const payload = JSON.stringify({
    slugs: ["novo-cpa"],
    couponCode: null,
    buyer: buyer(),
    payment: { method: "pix" },
  });
  const missing = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: payload,
  });
  assert.equal(missing.status, 401);
  const wrong = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(crypto.randomUUID(), "token-errado"),
    body: payload,
  });
  assert.equal(wrong.status, 401);
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
      return {
        id: "pay_pulso6001",
        status: "PENDING",
        billingType: "PIX",
        value: 997,
        dueDate: "2026-07-29",
        description: "CPA 2026 + ANCORD 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/6001",
      };
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
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa", "ancord-2026"],
      couponCode: null,
      buyer: buyer(),
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_pulso6001",
    status: "open",
    method: "pix",
    installments: 1,
    installmentCents: 99_700,
    totalCents: 99_700,
    pix: { qrCodeBase64: "aW1hZ2U=", emv: "000201PULSO", expiresAt: "2026-07-29" },
  });
  const payment = calls.find(([name]) => name === "payment")[1];
  assert.equal(payment.billingType, "PIX");
  assert.equal(payment.value, 997);
  assert.match(payment.externalReference, /^pulso:/);
  const callbackUpdate = calls.find(([name]) => name === "update")[2];
  assert.deepEqual(callbackUpdate, {
    billingType: "PIX",
    value: 997,
    dueDate: "2026-07-29",
    callback: {
      successUrl: "https://pulso.cyara.com.br/checkout/sucesso/?order_id=pay_pulso6001",
      autoRedirect: true,
    },
    description: "CPA 2026 + ANCORD 2026",
    externalReference: payment.externalReference,
  });
});

test("creates a finite Pix installment plan without increasing the customer total", async (context) => {
  const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_pix_plan407" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => {
      calls.push(["payment", payload]);
      return {
        id: "pay_pixplan6003",
        installment: "ins_pixplan6003",
        status: "PENDING",
        billingType: "PIX",
        value: 250,
        dueDate: "2026-07-29",
        description: "CPA 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/6003",
      };
    },
    updatePayment: async (id, payload) => {
      calls.push(["update", id, payload]);
      return { id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6003" };
    },
    getPixQrCode: async () => ({
      encodedImage: "aW1hZ2U=",
      payload: "000201PULSOPARCELADO",
      expirationDate: "2026-07-29",
    }),
    listInstallmentPayments: async () => ({ data: [] }),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: buyer(),
      payment: { method: "pix_installment", installments: 3 },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_pixplan6003",
    status: "open",
    method: "pix_installment",
    installments: 3,
    installmentCents: 16_617,
    totalCents: 49_850,
    pix: {
      qrCodeBase64: "aW1hZ2U=",
      emv: "000201PULSOPARCELADO",
      expiresAt: "2026-07-29",
    },
  });
  const payment = calls.find(([name]) => name === "payment")[1];
  assert.equal(payment.billingType, "PIX");
  assert.equal(payment.installmentCount, 3);
  assert.equal(payment.totalValue, 498.5);
  assert.equal("value" in payment, false);
});

test("recovers a Pix QR Code without creating a second charge", async (context) => {
  let paymentCalls = 0;
  let qrCalls = 0;
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_pix_recovery" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => {
      paymentCalls += 1;
      return {
        id: "pay_pix_recovery",
        status: "PENDING",
        billingType: "PIX",
        value: 498.5,
        dueDate: "2026-07-29",
        description: "CPA 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/recovery",
      };
    },
    updatePayment: async (id) => ({
      id,
      status: "PENDING",
      billingType: "PIX",
      value: 498.5,
      dueDate: "2026-07-29",
      invoiceUrl: "https://sandbox.asaas.com/i/recovery",
    }),
    getPayment: async (id) => ({ id, status: "PENDING" }),
    getPixQrCode: async () => {
      qrCalls += 1;
      if (qrCalls === 1) throw Object.assign(new Error("not ready"), { status: 404 });
      return { encodedImage: "aW1hZ2U=", payload: "000201RECOVERED", expirationDate: "2026-07-29" };
    },
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: buyer(),
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    orderId: "pay_pix_recovery",
    status: "open",
    method: "pix",
    installments: 1,
    installmentCents: 49_850,
    totalCents: 49_850,
    pixPending: true,
  });

  const recovery = await fetch(`${origin}/v1/checkout/orders/pay_pix_recovery/pix`);
  assert.equal(recovery.status, 200);
  assert.deepEqual(await recovery.json(), {
    id: "pay_pix_recovery",
    status: "open",
    pix: {
      qrCodeBase64: "aW1hZ2U=",
      emv: "000201RECOVERED",
      expiresAt: "2026-07-29",
    },
  });
  assert.equal(paymentCalls, 1);
  assert.equal(qrCalls, 2);
});

test("creates a ten-installment hosted Asaas invoice without receiving card data", async (context) => {
  const calls = [];
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_existing407" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => {
      calls.push(payload);
      return {
        id: "pay_pulso6002",
        status: "PENDING",
        billingType: "CREDIT_CARD",
        value: 49.85,
        dueDate: "2026-07-29",
        description: "CPA 2026",
        externalReference: payload.externalReference,
        invoiceUrl: "https://sandbox.asaas.com/i/6002",
      };
    },
    updatePayment: async (id, payload) => {
      calls.push(payload);
      return { id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/6002" };
    },
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
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
    totalCents: 49_850,
    redirectUrl: "https://sandbox.asaas.com/i/6002",
  });
  assert.equal(calls[0].billingType, "CREDIT_CARD");
  assert.equal(calls[0].installmentCount, 10);
  assert.equal(calls[0].totalValue, 498.5);
  assert.equal("value" in calls[0], false);
  assert.equal(JSON.stringify(calls[0]).includes("creditCard"), false);
  assert.equal(JSON.stringify(calls[0]).includes("cvv"), false);
  assert.deepEqual(calls[1], {
    billingType: "CREDIT_CARD",
    value: 49.85,
    dueDate: "2026-07-29",
    callback: {
      successUrl: "https://pulso.cyara.com.br/checkout/sucesso/?order_id=pay_pulso6002",
      autoRedirect: true,
    },
    description: "CPA 2026",
    externalReference: calls[0].externalReference,
  });
});

test("returns card terms separately without claiming Pix is interest-free", async (context) => {
  const origin = await serve(context, enabledEnvironment, { asaasClient: {} });
  const response = await fetch(`${origin}/v1/checkout/installments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: null }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.maximumInstallments, 10);
  assert.equal(result.maximumPixInstallments, 6);
  assert.equal(result.cardInterestFree, true);
  assert.equal(result.pixTotalPreserved, true);
  assert.equal(result.installments.length, 10);
  assert.equal(result.cardInstallments.length, 10);
  assert.equal(result.pixInstallments.length, 5);
  assert.deepEqual(result.pixInstallments[0], {
    number: 2,
    totalCents: 49_850,
    installmentCents: 24_925,
    lastInstallmentCents: 24_925,
    installmentAmountsCents: [24_925, 24_925],
  });
});

test("rejects Pix installment plans above six installments", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: buyer(),
      payment: { method: "pix_installment", installments: 7 },
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_installments");
});

test("rejects malformed birth date or address before calling Asaas", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  for (const badBuyer of [
    { ...buyer(), birthDate: "10/05/1985" },
    { ...buyer(), birthDate: "2035-01-01" },
    { ...buyer(), address: { postCode: "1300" } },
    { ...buyer(), address: { state: "XX" } },
  ]) {
    const response = await fetch(`${origin}/v1/checkout/orders`, {
      method: "POST",
      headers: trustedHeaders(),
      body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: null, buyer: badBuyer, payment: { method: "pix" } }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /invalid_birth_date|invalid_address/);
  }
});

test("persists full buyer identity for later reconciliation", async (context) => {
  const store = createInMemoryStore();
  const asaasClient = {
    findCustomersByDocument: async () => ({ data: [{ id: "cus_full_buyer" }] }),
    createCustomer: async () => assert.fail("Existing customer must be reused"),
    createPayment: async (payload) => ({
      id: "pay_full_buyer",
      status: "PENDING",
      billingType: "PIX",
      value: 750,
      dueDate: "2026-07-29",
      description: "CPA 2026",
      externalReference: payload.externalReference,
      invoiceUrl: "https://sandbox.asaas.com/i/fullbuyer",
    }),
    updatePayment: async (id) => ({ id, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/fullbuyer" }),
    getPixQrCode: async () => ({ encodedImage: "aW1hZ2U=", payload: "000201FULL" }),
  };
  const origin = await serve(context, enabledEnvironment, { store, asaasClient });
  const address = {
    postCode: "13000000",
    street: "Rua das Palmas",
    number: "45",
    complement: "Apto 71",
    district: "Jardim",
    city: "Campinas",
    state: "SP",
  };
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: { ...buyer(), birthDate: "1985-05-10", address },
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 201);
  const [listed] = await store.listOrders({ limit: 1 });
  const stored = await store.getOrderWithItems(listed.id);
  assert.equal(stored.buyerBirthDate, "1985-05-10");
  assert.deepEqual(stored.buyerAddress, address);
  assert.equal(stored.buyerPhone, "11999999999");
});

test("rejects invalid CPF or CNPJ before calling Asaas", async (context) => {
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: null,
      buyer: { ...buyer(), documentNumber: "45487468111" },
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_document",
    message: "CPF ou CNPJ inválido.",
    retryable: true,
  });
});

test("rejects coupons that reduce a Pix charge below the Asaas minimum", async (context) => {
  const store = createInMemoryStore();
  await store.saveCoupon({
    code: "QUASE100",
    discountBps: 9_999,
    active: true,
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    productSlugs: ["novo-cpa"],
  });
  const asaasClient = {
    findCustomersByDocument: async () => assert.fail("Asaas must not be called"),
  };
  const origin = await serve(context, enabledEnvironment, { store, asaasClient });
  const response = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST",
    headers: trustedHeaders(),
    body: JSON.stringify({
      slugs: ["novo-cpa"],
      couponCode: "QUASE100",
      buyer: buyer(),
      payment: { method: "pix" },
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "payment_amount_below_minimum",
    message: "O valor mínimo para pagamento por Pix é R$ 10,00. Ajuste o cupom ou adicione outro curso.",
    retryable: true,
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
      headers: trustedHeaders(),
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
  const payload = { slugs: ["novo-cpa"], couponCode: null, buyer: buyer(), payment: { method: "pix" } };
  const first = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST", headers: trustedHeaders(key), body: JSON.stringify(payload),
  });
  assert.equal(first.status, 502);
  const second = await fetch(`${origin}/v1/checkout/orders`, {
    method: "POST", headers: trustedHeaders(key), body: JSON.stringify(payload),
  });
  assert.equal(second.status, 201);
  assert.equal((await second.json()).orderId, "pay_retry6010");
  assert.equal(customerCalls, 2);
});

test("authenticates and deduplicates Asaas payment webhooks", async (context) => {
  const origin = await serve(context, enabledEnvironment, { asaasClient: {} });
  const event = {
    id: "evt_payment_6001&17558216",
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
