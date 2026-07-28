const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.length <= 160 && EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function displayName(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized.length >= 2 && normalized.length <= 120 ? normalized : null;
}

function password(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 128
    ? value
    : null;
}

function mobilePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length >= 10 && digits.length <= 13 ? digits : undefined;
}

export function validateCustomerCredentials(body) {
  const normalizedEmail = email(body?.email);
  const normalizedPassword = password(body?.password);
  if (!normalizedEmail || !normalizedPassword) return null;
  return { email: normalizedEmail, password: normalizedPassword };
}

export function validateCustomerRegistration(body) {
  const credentials = validateCustomerCredentials(body);
  const normalizedName = displayName(body?.displayName);
  if (!credentials || !normalizedName) return null;
  return { ...credentials, displayName: normalizedName };
}

export function validateCustomerProfile(body) {
  const normalizedName = displayName(body?.displayName);
  const normalizedPhone = mobilePhone(body?.mobilePhone);
  if (!normalizedName || normalizedPhone === undefined) return null;
  return { displayName: normalizedName, mobilePhone: normalizedPhone };
}

export function validateCustomerPasswordChange(body) {
  const currentPassword = password(body?.currentPassword);
  const newPassword = password(body?.newPassword);
  if (!currentPassword || !newPassword || currentPassword === newPassword) return null;
  return { currentPassword, newPassword };
}

export function validateCustomerEmail(body) {
  const normalizedEmail = email(body?.email);
  return normalizedEmail ? { email: normalizedEmail } : null;
}

export function validateCustomerPasswordReset(body) {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const newPassword = password(body?.newPassword);
  if (token.length < 32 || token.length > 256 || !newPassword) return null;
  return { token, newPassword };
}

export function validateCustomerActionToken(body) {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  return token.length >= 32 && token.length <= 256 ? token : null;
}

export function publicCustomer(customer) {
  return {
    id: customer.id,
    email: customer.email,
    displayName: customer.displayName,
    mobilePhone: customer.mobilePhone ?? null,
    documentLast4: customer.documentLast4 ?? null,
    emailVerified: Boolean(customer.emailVerifiedAt),
    createdAt: customer.createdAt ?? null,
  };
}
