import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";
import { createInMemoryStore } from "../src/admin/in-memory-store.js";
import { createEnrollmentQueue } from "../src/integrations/art/queue.js";

const WEBHOOK_TOKEN = "pulso-enrollment-test-token-with-32-chars";

async function waitFor(predicate, timeoutMs = 2_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

function stubService(behavior) {
  const calls = [];
  return {
    calls,
    enrollStudent: async (input) => { calls.push(input); return behavior(input); },
  };
}

const confirmed = () => ({ status: "CONFIRMED", userId: "u-1", idTurma: 4058, turmaSelection: "turma-unica", enrollment: { tag: "cpa2026" } });

async function serve(context, { behavior = confirmed, maxRetries = 3, retryDelayMs = 1 } = {}) {
  const store = createInMemoryStore();
  const service = stubService(behavior);
  const queue = createEnrollmentQueue({
    store,
    enrollmentService: service,
    environment: { artMaxRetries: maxRetries, artRetryDelayMs: retryDelayMs },
    log: () => {},
  });
  const { app, ready } = createApp({
    PORT: "3103",
    PUBLIC_ORIGIN: "https://pulso.cyara.com.br",
    NODE_ENV: "test",
    ENROLLMENT_ENABLED: "true",
    ASAAS_ENABLED: "true",
    ASAAS_ENVIRONMENT: "sandbox",
    ASAAS_API_KEY: "$aact_test_key",
    ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    ADMIN_BOOTSTRAP_TOKEN: "enrollment-bootstrap-token",
    SESSION_PEPPER: "enrollment-test-pepper",
  }, { store, artIntegration: { queue } });
  await ready;
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, store, service, queue };
}

async function createOpenOrder(store, { providerOrderId, cpf = "19100000000" } = {}) {
  await store.createOrder({
    provider: "asaas",
    providerOrderId,
    status: "open",
    buyerEmail: "aluno@example.test",
    buyerCpf: cpf,
    buyerName: "Aluno Teste",
    buyerPhone: "11999999999",
    subtotalCents: 75_000,
    discountCents: 0,
    totalCents: 75_000,
    lines: [{ product: { slug: "novo-cpa", title: "CPA 2026" }, basePriceCents: 75_000, discountCents: 0, finalPriceCents: 75_000 }],
  });
}

function webhookBody(providerOrderId, eventId) {
  return {
    id: eventId,
    event: "PAYMENT_CONFIRMED",
    payment: { id: providerOrderId, status: "CONFIRMED", externalReference: "pulso:attempt-enroll" },
  };
}

async function postWebhook(base, providerOrderId, eventId) {
  return fetch(`${base}/v1/webhooks/asaas`, {
    method: "POST",
    headers: { "content-type": "application/json", "asaas-access-token": WEBHOOK_TOKEN },
    body: JSON.stringify(webhookBody(providerOrderId, eventId)),
  });
}

test("enrolls automatically when a single-payment webhook turns the order paid", async (context) => {
  const { base, store, service } = await serve(context);
  await createOpenOrder(store, { providerOrderId: "pay_enroll1" });
  const response = await postWebhook(base, "pay_enroll1", "evt_enroll1&1");
  assert.equal(response.status, 200);
  const job = await waitFor(async () => {
    const [latest] = await store.listEnrollmentJobs({ limit: 1 });
    return latest?.status === "confirmed" ? latest : null;
  });
  assert.equal(job.courseSlug, "novo-cpa");
  assert.equal(job.sourceTag, "cpa2026");
  assert.equal(job.buyerCpf, "19100000000");
  assert.equal(job.idTurma, 4058);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].tag, "cpa2026");
  assert.equal(service.calls[0].cpf, "19100000000");
});

test("does not enroll twice for duplicate or non-transitioning webhooks", async (context) => {
  const { base, store, service } = await serve(context);
  await createOpenOrder(store, { providerOrderId: "pay_enroll2" });
  await postWebhook(base, "pay_enroll2", "evt_enroll2&1");
  await waitFor(async () => (await store.listEnrollmentJobs({ limit: 1 }))[0]?.status === "confirmed");
  await postWebhook(base, "pay_enroll2", "evt_enroll2&1");
  await postWebhook(base, "pay_enroll2", "evt_enroll2&2");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await store.listEnrollmentJobs({ limit: 10 })).length, 1);
  assert.equal(service.calls.length, 1);
});

test("skips enrollment when the paid order has no buyer CPF", async (context) => {
  const { base, store, service } = await serve(context);
  await store.createOrder({
    provider: "asaas", providerOrderId: "pay_enroll3", status: "open", buyerEmail: "semcpf@example.test",
    subtotalCents: 75_000, discountCents: 0, totalCents: 75_000,
    lines: [{ product: { slug: "novo-cpa", title: "CPA 2026" }, basePriceCents: 75_000, discountCents: 0, finalPriceCents: 75_000 }],
  });
  await postWebhook(base, "pay_enroll3", "evt_enroll3&1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await store.listEnrollmentJobs({ limit: 10 })).length, 0);
  assert.equal(service.calls.length, 0);
});

test("marks an enrollment failed after exhausting retries", async (context) => {
  const { base, store } = await serve(context, {
    behavior: () => { throw new Error("art platform down"); },
    maxRetries: 2,
    retryDelayMs: 1,
  });
  await createOpenOrder(store, { providerOrderId: "pay_enroll4" });
  await postWebhook(base, "pay_enroll4", "evt_enroll4&1");
  const job = await waitFor(async () => {
    const [latest] = await store.listEnrollmentJobs({ limit: 1 });
    return latest?.status === "failed" ? latest : null;
  });
  assert.match(job.error, /art platform down/);
});

test("admin can list enrollments and requeue a failed job back to confirmed", async (context) => {
  let shouldFail = true;
  const { base, store } = await serve(context, {
    behavior: () => { if (shouldFail) throw new Error("transient"); return confirmed(); },
    maxRetries: 1,
    retryDelayMs: 1,
  });
  await createOpenOrder(store, { providerOrderId: "pay_enroll5" });
  await postWebhook(base, "pay_enroll5", "evt_enroll5&1");
  const failed = await waitFor(async () => {
    const [latest] = await store.listEnrollmentJobs({ limit: 1 });
    return latest?.status === "failed" ? latest : null;
  });

  const bootstrap = await fetch(`${base}/v1/admin/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "enrollment-bootstrap-token", email: "admin@pulso.test", password: "long-and-unique-password" }) });
  assert.equal(bootstrap.status, 201);
  const login = await fetch(`${base}/v1/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@pulso.test", password: "long-and-unique-password" }) });
  const cookies = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const csrf = decodeURIComponent(/pulso_admin_csrf=([^;]+)/.exec(cookies)[1]);

  const list = await fetch(`${base}/v1/admin/enrollments`, { headers: { cookie: cookies } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).enrollments.length, 1);

  shouldFail = false;
  const requeue = await fetch(`${base}/v1/admin/enrollments/${failed.id}/requeue`, { method: "POST", headers: { cookie: cookies, "x-csrf-token": csrf } });
  assert.equal(requeue.status, 200);
  await waitFor(async () => (await store.getEnrollmentJob(failed.id)).status === "confirmed");
  assert.equal((await store.getEnrollmentJob(failed.id)).status, "confirmed");
});

test("admin activates selected courses for one registered customer without duplicates", async (context) => {
  const { base, store, service } = await serve(context);
  const customer = await store.createCustomer({
    email: "cliente.ativacao@example.test",
    displayName: "Cliente Ativacao",
    passwordSalt: "salt",
    passwordHash: "hash",
  });

  await fetch(`${base}/v1/admin/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "enrollment-bootstrap-token",
      email: "admin@pulso.test",
      password: "long-and-unique-password",
    }),
  });
  const login = await fetch(`${base}/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@pulso.test",
      password: "long-and-unique-password",
    }),
  });
  const cookies = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const csrf = decodeURIComponent(/pulso_admin_csrf=([^;]+)/.exec(cookies)[1]);
  const adminHeaders = {
    "content-type": "application/json",
    cookie: cookies,
    "x-csrf-token": csrf,
  };

  const customers = await fetch(`${base}/v1/admin/customers`, { headers: { cookie: cookies } });
  assert.equal(customers.status, 200);
  assert.equal((await customers.json()).customers[0].id, customer.id);

  const activationBody = {
    customerId: customer.id,
    fullName: "Cliente Ativacao",
    documentNumber: "19100000000",
    courseSlugs: ["novo-cpa", "ancord-2026"],
  };
  const activation = await fetch(`${base}/v1/admin/course-activations`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify(activationBody),
  });
  assert.equal(activation.status, 201);
  const activationResult = await activation.json();
  assert.equal(activationResult.activation.created, 2);
  assert.equal(activationResult.activation.customer.email, customer.email);

  await waitFor(async () => {
    const jobs = await store.listEnrollmentJobs({ limit: 10 });
    return jobs.length === 2 && jobs.every((job) => job.status === "confirmed");
  });
  assert.deepEqual(
    service.calls.map((call) => call.tag).sort(),
    ["ancord-2026", "cpa2026"],
  );

  const duplicate = await fetch(`${base}/v1/admin/course-activations`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify(activationBody),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, "courses_already_activated");
  assert.equal(service.calls.length, 2);
});
