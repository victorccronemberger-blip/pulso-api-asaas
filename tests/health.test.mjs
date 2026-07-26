import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/application.js";

test("reports a healthy but inactive checkout capability", async (context) => {
  const { app } = createApp({
    PORT: "3100",
    PUBLIC_ORIGIN: "https://pulso.cyara.com.br",
    CHECKOUT_ENABLED: "false",
  });
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
    headers: { origin: "https://pulso.cyara.com.br" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://pulso.cyara.com.br");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "pulso-api",
    capabilities: { checkout: false },
  });
});

test("keeps future business routes closed", async (context) => {
  const { app } = createApp();
  const server = app.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/checkout/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "not_found");
});
