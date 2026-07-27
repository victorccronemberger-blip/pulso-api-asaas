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

function parseOptionalInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("APPMAX_APP_NUMERICAL_ID must be a positive integer.");
  }
  return parsed;
}

function parsePositiveInteger(value, fallback, name) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseEnvironment(value) {
  const environment = String(value ?? "sandbox").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("APPMAX_ENVIRONMENT must be sandbox or production.");
  }
  return environment;
}

export function getEnvironment(source = process.env) {
  const appmaxEnvironment = parseEnvironment(source.APPMAX_ENVIRONMENT);
  const appmaxMerchantClientId = source.APPMAX_MERCHANT_CLIENT_ID?.trim() || null;
  const appmaxMerchantClientSecret = source.APPMAX_MERCHANT_CLIENT_SECRET?.trim() || null;
  const appmaxExternalId = source.APPMAX_EXTERNAL_ID?.trim()
    || "8623e65e-2ddf-4ec0-87f0-aff3bc26a6aa";
  const appmaxRequested = parseBoolean(source.APPMAX_ENABLED ?? "false");
  const appmaxAvailable = Boolean(
    appmaxMerchantClientId
    && appmaxMerchantClientSecret
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appmaxExternalId),
  );

  return Object.freeze({
    host: source.HOST?.trim() || "0.0.0.0",
    port: parsePort(source.PORT),
    publicOrigin: source.PUBLIC_ORIGIN?.trim() || "https://pulso.cyara.com.br",
    adminOrigin: source.ADMIN_ORIGIN?.trim() || source.PUBLIC_ORIGIN?.trim() || "https://pulso.cyara.com.br",
    sitesOrigin: source.SITES_ORIGIN?.trim() || "https://pulso-bancario.victor-cronemberger.chatgpt.site",
    mysqlUrl: source.MYSQL_URL?.trim() || null,
    adminBootstrapToken: source.ADMIN_BOOTSTRAP_TOKEN?.trim() || null,
    sessionPepper: source.SESSION_PEPPER?.trim() || null,
    sessionTtlSeconds: parsePositiveInteger(source.ADMIN_SESSION_TTL_SECONDS, 28_800, "ADMIN_SESSION_TTL_SECONDS"),
    appmaxWebhookSecret: source.APPMAX_WEBHOOK_SECRET?.trim() || null,
    appmaxEnvironment,
    appmaxAuthOrigin: appmaxEnvironment === "production"
      ? "https://auth.appmax.com.br"
      : "https://auth.sandboxappmax.com.br",
    appmaxApiOrigin: appmaxEnvironment === "production"
      ? "https://api.appmax.com.br"
      : "https://api.sandboxappmax.com.br",
    appmaxMerchantClientId,
    appmaxMerchantClientSecret,
    appmaxExternalId,
    appmaxAppUuid: source.APPMAX_APP_UUID?.trim() || null,
    appmaxAppNumericalId: parseOptionalInteger(source.APPMAX_APP_NUMERICAL_ID),
    appmaxSoftDescriptor: (source.APPMAX_SOFT_DESCRIPTOR?.trim() || "PULSO")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 13)
      .toUpperCase(),
    appmaxAvailable,
    checkoutEnabled: appmaxRequested && appmaxAvailable,
  });
}
