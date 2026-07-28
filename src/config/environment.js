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

function parsePositiveInteger(value, fallback, name) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseEnvironment(value) {
  const environment = String(value ?? "sandbox").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("ASAAS_ENVIRONMENT must be sandbox or production.");
  }
  return environment;
}

function parseAsaasApiKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return null;
  // Some managed Node.js runtimes interpolate a leading "$" while injecting
  // environment variables. Accept the same key without that transport prefix
  // and restore it only inside the process.
  return key.startsWith("aact_") ? `$${key}` : key;
}

export function getEnvironment(source = process.env) {
  const asaasEnvironment = parseEnvironment(source.ASAAS_ENVIRONMENT);
  const asaasApiKey = parseAsaasApiKey(source.ASAAS_API_KEY);
  const asaasWebhookToken = source.ASAAS_WEBHOOK_TOKEN?.trim() || null;
  const asaasRequested = parseBoolean(source.ASAAS_ENABLED ?? "false");
  const asaasAvailable = Boolean(asaasApiKey);

  return Object.freeze({
    nodeEnvironment: source.NODE_ENV?.trim().toLowerCase() || "development",
    host: source.HOST?.trim() || "0.0.0.0",
    port: parsePort(source.PORT),
    publicOrigin: source.PUBLIC_ORIGIN?.trim() || "https://pulso.cyara.com.br",
    adminOrigin: source.ADMIN_ORIGIN?.trim() || source.PUBLIC_ORIGIN?.trim() || "https://pulso.cyara.com.br",
    sitesOrigin: source.SITES_ORIGIN?.trim() || "https://pulso-bancario.victor-cronemberger.chatgpt.site",
    mysqlUrl: source.MYSQL_URL?.trim() || null,
    adminBootstrapToken: source.ADMIN_BOOTSTRAP_TOKEN?.trim() || null,
    sessionPepper: source.SESSION_PEPPER?.trim() || null,
    sessionTtlSeconds: parsePositiveInteger(source.ADMIN_SESSION_TTL_SECONDS, 28_800, "ADMIN_SESSION_TTL_SECONDS"),
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
