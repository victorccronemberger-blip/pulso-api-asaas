import { checkoutCatalog } from "../domain/catalog.js";
import { normalizeCouponCode } from "../domain/coupons.js";

export function validateCredentials(input) {
  const email = String(input?.email ?? "").trim().toLowerCase();
  const password = String(input?.password ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160 || password.length < 12 || password.length > 200) {
    throw new Error("Credenciais inv\u00e1lidas. Use uma senha de ao menos 12 caracteres.");
  }
  return { email, password };
}

function dateOrNull(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${field} inv\u00e1lido.`);
  return date.toISOString();
}

export function validateCoupon(input, current = {}) {
  const code = normalizeCouponCode(input?.code ?? current.code);
  const discountBps = Number(input?.discountBps ?? current.discountBps);
  const active = input?.active === undefined ? (current.active ?? true) : input.active === true;
  const startsAt = dateOrNull(input?.startsAt ?? current.startsAt, "In\u00edcio");
  const endsAt = dateOrNull(input?.endsAt ?? current.endsAt, "Fim");
  const maxRedemptions = input?.maxRedemptions === undefined ? (current.maxRedemptions ?? null) : (input.maxRedemptions === null ? null : Number(input.maxRedemptions));
  const productSlugs = input?.productSlugs === undefined ? (current.productSlugs ?? []) : input.productSlugs;
  if (!code || !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) throw new Error("C\u00f3digo de cupom inv\u00e1lido.");
  if (!Number.isInteger(discountBps) || discountBps < 1 || discountBps > 9_999) throw new Error("Desconto deve estar entre 1 e 9999 pontos-base.");
  if (startsAt && endsAt && startsAt >= endsAt) throw new Error("O fim deve ser posterior ao in\u00edcio.");
  if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 1_000_000)) throw new Error("Limite de usos inv\u00e1lido.");
  if (!Array.isArray(productSlugs) || productSlugs.some((slug) => typeof slug !== "string" || !checkoutCatalog[slug])) throw new Error("Escopo de produtos inv\u00e1lido.");
  return { code, discountBps, active, startsAt, endsAt, maxRedemptions, productSlugs: [...new Set(productSlugs)] };
}

export function validateCampaign(input, availableCodes) {
  const activeCouponCode = input?.activeCouponCode === null || input?.activeCouponCode === "" ? null : normalizeCouponCode(input?.activeCouponCode);
  if (activeCouponCode && !availableCodes.includes(activeCouponCode)) throw new Error("O cupom em destaque n\u00e3o existe.");
  const headline = String(input?.headline ?? "").trim().slice(0, 120);
  return { activeCouponCode, headline: headline || null };
}
