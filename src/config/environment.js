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

function parseList(value, fallback = []) {
  const source = String(value ?? "").trim();
  if (!source) return fallback;
  return source.split(",").map((item) => item.trim()).filter(Boolean);
}

// Contas de serviço da plataforma ART (formato "email:senha,email2:senha2").
// São a fonte PRIMÁRIA de descoberta dinâmica de turmas: login dedicado →
// RS256 → listagem real de /v1/services/turmas em tempo real. Use contas que
// ninguém usa interativamente (login rotaciona o token e derruba sessão alheia).
function parseServiceAccounts(value) {
  return parseList(value)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) return null;
      const email = entry.slice(0, separator).trim();
      const password = entry.slice(separator + 1).trim();
      return email && password ? { email, password } : null;
    })
    .filter(Boolean);
}

// TLS verification is rejected only for the ART platform when explicitly opted in
// (its origin historically ships an unverifiable certificate). Payment provider calls
// always keep full TLS verification regardless of this flag.
function parseTlsRejectUnauthorized(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off") return false;
  return true;
}

function parseEnvironment(value) {
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
  // Some managed Node.js runtimes interpolate a leading "$" while injecting
  // environment variables or preserve its escape character. Normalize only
  // those transport forms and restore the original credential in-process.
  return key.startsWith("aact_") ? `$${key}` : key;
}

export function getEnvironment(source = process.env) {
  const asaasEnvironment = parseEnvironment(source.ASAAS_ENVIRONMENT);
  const asaasApiKey = parseAsaasApiKey(source.ASAAS_API_KEY);
  const asaasWebhookToken = source.ASAAS_WEBHOOK_TOKEN?.trim() || null;
  const asaasRequested = parseBoolean(source.ASAAS_ENABLED ?? "false");
  const asaasAvailable = Boolean(asaasApiKey);

  const enrollmentEnabled = parseBoolean(source.ENROLLMENT_ENABLED ?? "false");
  const artTlsRejectUnauthorized = parseTlsRejectUnauthorized(source.ART_TLS_REJECT_UNAUTHORIZED ?? "1");

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
    smtpHost: source.SMTP_HOST?.trim() || "smtp.hostinger.com",
    smtpPort: parsePositiveInteger(source.SMTP_PORT, 465, "SMTP_PORT"),
    smtpSecure: parseBoolean(source.SMTP_SECURE ?? "true"),
    smtpUser: source.SMTP_USER?.trim() || null,
    smtpPassword: source.SMTP_PASSWORD?.trim() || null,
    emailFrom: source.EMAIL_FROM?.trim() || source.SMTP_USER?.trim() || null,
    emailAvailable: Boolean(source.SMTP_USER?.trim() && source.SMTP_PASSWORD?.trim()),
    enrollmentEnabled,
    artApiOrigin: source.ART_API_BASE?.trim() || "https://api.academiarafaeltoro.com.br",
    artIdmOrigin: source.ART_IDM_BASE?.trim() || "https://ms-idm.academiarafaeltoro.com.br",
    artServiceAccounts: parseServiceAccounts(source.ART_SERVICE_ACCOUNTS),
    artRequestTimeoutMs: parsePositiveInteger(source.ART_REQUEST_TIMEOUT_MS, 30_000, "ART_REQUEST_TIMEOUT_MS"),
    artPollTimeoutMs: parsePositiveInteger(source.ART_POLL_TIMEOUT_MS, 60_000, "ART_POLL_TIMEOUT_MS"),
    artPollIntervalMs: parsePositiveInteger(source.ART_POLL_INTERVAL_MS, 5_000, "ART_POLL_INTERVAL_MS"),
    artProvisionTimeoutMs: parsePositiveInteger(source.ART_PROVISION_TIMEOUT_MS, 120_000, "ART_PROVISION_TIMEOUT_MS"),
    artMaxRetries: parsePositiveInteger(source.ART_MAX_RETRIES, 3, "ART_MAX_RETRIES"),
    artRetryDelayMs: parsePositiveInteger(source.ART_RETRY_DELAY_MS, 15_000, "ART_RETRY_DELAY_MS"),
    artTlsRejectUnauthorized,
  });
}
