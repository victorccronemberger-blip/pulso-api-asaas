import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

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

test("reports a healthy API while keeping checkout disabled without a Stripe key", async (context) => {
  const origin = await serve(context, { CHECKOUT_ENABLED: "true" });
  const response = await fetch(`${origin}/health`, {
    headers: { origin: "https://pulso.cyara.com.br" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://pulso.cyara.com.br");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "pulso-api",
    capabilities: { checkout: false },
  });

  const status = await fetch(`${origin}/v1/checkout/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { enabled: false });
});

test("rejects checkout creation while the payment capability is disabled", async (context) => {
  const origin = await serve(context, { CHECKOUT_ENABLED: "false" });
  const response = await fetch(`${origin}/v1/checkout/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slugs: ["novo-cpa"], couponCode: "PULSO35" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "checkout_unavailable");
});

test("creates a hosted Stripe Checkout session from server-authoritative prices", async (context) => {
  const calls = [];
  const stripeClient = {
    checkout: {
      sessions: {
        create: async (...args) => {
          calls.push(args);
          return { id: "cs_test_created", url: "https://checkout.stripe.com/c/pay/cs_test_created" };
        },
        retrieve: async () => ({ id: "cs_test_paid", payment_status: "paid", status: "complete" }),
      },
    },
    webhooks: { constructEvent() {} },
  };
  const origin = await serve(context, {
    CHECKOUT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
  }, { stripeClient });

  const response = await fetch(`${origin}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "12345678-1234-4234-8234-123456789012",
    },
    body: JSON.stringify({
      slugs: ["novo-cpa", "simulados-ancord-2026"],
      couponCode: "pulso35",
      clientTotalCents: 1,
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    url: "https://checkout.stripe.com/c/pay/cs_test_created",
  });
  assert.equal(calls.length, 1);

  const [session, requestOptions] = calls[0];
  assert.equal(session.mode, "payment");
  assert.equal(session.ui_mode, "hosted");
  assert.equal(session.line_items[0].price_data.unit_amount, 97_305);
  assert.equal(session.line_items[1].price_data.unit_amount, 27_950);
  assert.equal(session.metadata.subtotal_cents, "192700");
  assert.equal(session.metadata.discount_cents, "67445");
  assert.equal(session.metadata.total_cents, "125255");
  assert.equal(session.metadata.coupon_code, "PULSO35");
  assert.equal(requestOptions.idempotencyKey, "pulso:12345678-1234-4234-8234-123456789012");
});

test("rejects products and coupons that are not in the server catalog", async (context) => {
  const stripeClient = {
    checkout: { sessions: { create: async () => assert.fail("Stripe must not be called") } },
    webhooks: { constructEvent() {} },
  };
  const origin = await serve(context, {
    CHECKOUT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
  }, { stripeClient });

  for (const payload of [
    { slugs: ["produto-inventado"], couponCode: null },
    { slugs: ["novo-cpa"], couponCode: "DESCONTO100" },
  ]) {
    const response = await fetch(`${origin}/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }
});

test("verifies the raw Stripe webhook signature before processing an event", async (context) => {
  const events = [];
  let receivedBody;
  const stripeClient = {
    checkout: { sessions: {} },
    webhooks: {
      constructEvent(body, signature, secret) {
        receivedBody = body;
        assert.equal(signature, "signed");
        assert.equal(secret, "whsec_placeholder");
        return {
          id: "evt_test_1",
          type: "checkout.session.completed",
          data: { object: { id: "cs_test_1", payment_status: "paid" } },
        };
      },
    },
  };
  const origin = await serve(context, {
    CHECKOUT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
  }, {
    stripeClient,
    onStripeEvent: async (event) => events.push(event),
  });

  const response = await fetch(`${origin}/v1/webhooks/stripe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "signed",
    },
    body: JSON.stringify({ id: "evt_test_1" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.ok(Buffer.isBuffer(receivedBody));
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "evt_test_1");
});

test("returns only a sanitized payment status to the storefront", async (context) => {
  const stripeClient = {
    checkout: {
      sessions: {
        retrieve: async (sessionId) => ({
          id: sessionId,
          payment_status: "paid",
          status: "complete",
          customer_details: { email: "private@example.com" },
        }),
      },
    },
    webhooks: { constructEvent() {} },
  };
  const origin = await serve(context, {
    CHECKOUT_ENABLED: "false",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
  }, { stripeClient });

  const response = await fetch(`${origin}/v1/checkout/sessions/cs_test_123`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "cs_test_123", status: "paid" });
});
