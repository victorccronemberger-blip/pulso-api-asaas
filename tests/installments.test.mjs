import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/store/in-memory-store.js";
import {
  createInstallmentService,
  publicInstallmentPlan,
} from "../src/services/installment-service.js";

const environment = {
  ASAAS_ENABLED: "true",
  ASAAS_ENVIRONMENT: "sandbox",
  ASAAS_API_KEY: "$aact_test_key",
  ASAAS_WEBHOOK_TOKEN: "pulso-installment-webhook-token-2026",
  TRUSTED_CHECKOUT_TOKEN: "pulso-trusted-checkout-token-2026",
};

const providerRows = [
  {
    id: "pay_installment_01",
    installment: "ins_plan_123456",
    installmentNumber: 1,
    status: "CONFIRMED",
    dueDate: "2026-08-10",
    value: 50,
    invoiceUrl: "https://sandbox.asaas.com/i/pay_installment_01",
    paymentDate: "2026-08-01",
  },
  {
    id: "pay_installment_02",
    installment: "ins_plan_123456",
    installmentNumber: 2,
    status: "PENDING",
    dueDate: "2026-09-10",
    value: 50,
    invoiceUrl: "https://sandbox.asaas.com/i/pay_installment_02",
  },
  {
    id: "pay_installment_03",
    installment: "ins_plan_123456",
    installmentNumber: 3,
    status: "PENDING",
    dueDate: "2026-10-10",
    value: 50,
    invoiceUrl: "https://malicious.example/i/pay_installment_03",
  },
];

async function createPlanOrder(store) {
  return store.createOrder({
    provider: "asaas",
    providerOrderId: "pay_installment_01",
    providerGroupId: "ins_plan_123456",
    status: "open",
    buyerEmail: "cliente@pulso.test",
    paymentMethod: "pix_installment",
    installments: 3,
    installmentCents: 5_000,
    subtotalCents: 15_000,
    discountCents: 0,
    totalCents: 15_000,
    couponCode: null,
    lines: [{
      product: { slug: "novo-cpa", title: "Novo CPA" },
      basePriceCents: 15_000,
      discountCents: 0,
      finalPriceCents: 15_000,
    }],
  });
}

async function serve(context, store, asaasClient) {
  const { app } = createApp(environment, { store, asaasClient });
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("synchronizes the authoritative Asaas plan and exposes only safe payment links", async () => {
  const store = createInMemoryStore();
  const order = await createPlanOrder(store);
  const service = createInstallmentService({
    store,
    asaasClient: {
      async listInstallmentPayments(id) {
        assert.equal(id, "ins_plan_123456");
        return { data: providerRows };
      },
    },
  });

  const plan = await service.sync(order);
  assert.deepEqual({
    total: plan.totalInstallments,
    paid: plan.paidInstallments,
    remaining: plan.remainingInstallments,
    next: plan.nextInstallmentNumber,
    nextValue: plan.nextInstallmentCents,
  }, { total: 3, paid: 1, remaining: 2, next: 2, nextValue: 5_000 });
  assert.equal(plan.installments[1].status, "open");
  assert.equal(plan.installments[1].paymentUrl, "https://sandbox.asaas.com/i/pay_installment_02");
  assert.equal(plan.installments[2].status, "scheduled");
  assert.equal(plan.installments[2].paymentUrl, null);

  const [stored] = await store.listOrders({ limit: 1 });
  assert.equal(stored.status, "partially_paid");
  assert.equal(stored.paidCents, 5_000);
  assert.equal(stored.paidInstallments, 1);
});

test("processes each Pix installment webhook independently and idempotently", async (context) => {
  const store = createInMemoryStore();
  await createPlanOrder(store);
  const base = await serve(context, store, {
    async listInstallmentPayments() { return { data: [] }; },
  });

  async function send(row, eventId) {
    return fetch(`${base}/v1/webhooks/asaas`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "asaas-access-token": environment.ASAAS_WEBHOOK_TOKEN,
      },
      body: JSON.stringify({
        id: eventId,
        event: "PAYMENT_CONFIRMED",
        payment: { ...row, externalReference: "pulso:test-plan" },
      }),
    });
  }

  const first = await send(providerRows[0], "evt_installment_0001");
  assert.equal(first.status, 200);
  const duplicate = await send(providerRows[0], "evt_installment_0001");
  assert.deepEqual(await duplicate.json(), { received: true, duplicate: true });

  let [order] = await store.listOrders({ limit: 1 });
  assert.equal(order.status, "partially_paid");
  assert.equal(order.paidInstallments, 1);

  await send({ ...providerRows[1], status: "CONFIRMED", paymentDate: "2026-09-01" }, "evt_installment_0002");
  await send({ ...providerRows[2], status: "CONFIRMED", paymentDate: "2026-10-01" }, "evt_installment_0003");
  [order] = await store.listOrders({ limit: 1 });
  assert.equal(order.status, "paid");
  assert.equal(order.paidInstallments, 3);
  assert.equal(order.paidCents, 15_000);
});

test("public plan keeps the expected shape when the provider has not listed parcels yet", () => {
  assert.deepEqual(publicInstallmentPlan([], 4), {
    totalInstallments: 4,
    paidInstallments: 0,
    remainingInstallments: 4,
    nextInstallmentNumber: null,
    nextDueDate: null,
    nextInstallmentCents: null,
    installments: [],
  });
});

test("reconciles an early future-installment webhook into one local order", async () => {
  const store = createInMemoryStore();
  const early = await store.updatePaymentInstallmentFromWebhook({
    provider: "asaas",
    providerOrderId: "pay_installment_02",
    providerGroupId: "ins_plan_123456",
    eventId: "evt_installment_early",
    installment: {
      providerPaymentId: "pay_installment_02",
      providerGroupId: "ins_plan_123456",
      number: 2,
      status: "open",
      dueDate: "2026-09-10",
      amountCents: 5_000,
      paymentUrl: "https://sandbox.asaas.com/i/pay_installment_02",
      paidAt: null,
    },
  });
  const enriched = await createPlanOrder(store);
  assert.equal(enriched.id, early.id);
  assert.equal((await store.listOrders()).length, 1);
});
