function parseBoolean(value) {
  return String(value).trim().toLowerCase() === "true";
}

function parsePort(value) {
  const port = Number(value ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return port;
}

export function getEnvironment(source = process.env) {
  const stripeSecretKey = source.STRIPE_SECRET_KEY?.trim() || null;
  const stripeWebhookSecret = source.STRIPE_WEBHOOK_SECRET?.trim() || null;
  const checkoutRequested = parseBoolean(source.CHECKOUT_ENABLED ?? "false");
  return Object.freeze({
    host: source.HOST?.trim() || "0.0.0.0",
    port: parsePort(source.PORT),
    publicOrigin: source.PUBLIC_ORIGIN?.trim() || "https://pulso.cyara.com.br",
    stripeSecretKey,
    stripeWebhookSecret,
    stripeAvailable: Boolean(stripeSecretKey),
    checkoutEnabled: checkoutRequested && Boolean(stripeSecretKey),
    webhookConfigured: Boolean(stripeSecretKey && stripeWebhookSecret),
  });
}
