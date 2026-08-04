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

function parseAsaasEnvironment(value) {
  const environment = String(value ?? "sandbox").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("ASAAS_ENVIRONMENT must be sandbox or production.");
  }
  return environment;
}

function parseAsaasApiKey(value) {
  const transported = String(value ?? "").trim();
  const key = transported.startsWith("\\$aact_") ? transported.slice(1) : transported;
  if (!key) return null;
  // Alguns runtimes gerenciados interpolam ou escapam o "$" inicial ao injetar
  // variáveis de ambiente. Normaliza essas formas de transporte e devolve a
  // credencial original ao processo.
  return key.startsWith("aact_") ? `$${key}` : key;
}

export function getEnvironment(source = process.env) {
  const asaasEnvironment = parseAsaasEnvironment(source.ASAAS_ENVIRONMENT);
  const asaasApiKey = parseAsaasApiKey(source.ASAAS_API_KEY);
  const asaasWebhookToken = source.ASAAS_WEBHOOK_TOKEN?.trim() || null;
  const asaasRequested = parseBoolean(source.ASAAS_ENABLED ?? "false");
  const asaasAvailable = Boolean(asaasApiKey);

  return Object.freeze({
    nodeEnvironment: source.NODE_ENV?.trim().toLowerCase() || "development",
    host: source.HOST?.trim() || "0.0.0.0",
    port: parsePort(source.PORT),
    publicOrigin: source.PUBLIC_ORIGIN?.trim() || "https://pulso.cyara.com.br",
    mysqlUrl: source.MYSQL_URL?.trim() || null,
    // Segredo compartilhado com o frontend (LMS): criação de pedidos via
    // chamada servidor-a-servidor (cabeçalho x-pulso-trusted-token).
    trustedCheckoutToken: source.TRUSTED_CHECKOUT_TOKEN?.trim() || null,
    asaasEnvironment,
    asaasApiOrigin: asaasEnvironment === "production"
      ? "https://api.asaas.com/v3"
      : "https://api-sandbox.asaas.com/v3",
    asaasApiKey,
    asaasWebhookToken,
    asaasAvailable,
    checkoutEnabled: asaasRequested && asaasAvailable,
  });
}
