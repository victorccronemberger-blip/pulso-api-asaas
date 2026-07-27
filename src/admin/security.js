import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export function randomToken() {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(value, pepper) {
  return createHmac("sha256", String(pepper ?? "")).update(String(value)).digest("hex");
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return { salt, hash: Buffer.from(hash).toString("base64url") };
}

export async function verifyPassword(password, record) {
  const candidate = await scrypt(password, record.passwordSalt, 64, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  const stored = Buffer.from(record.passwordHash, "base64url");
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }).filter(([key]) => key));
}

export function serializeCookie(name, value, { httpOnly = false, maxAge = 0 } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Strict; Secure${httpOnly ? "; HttpOnly" : ""}`;
}
