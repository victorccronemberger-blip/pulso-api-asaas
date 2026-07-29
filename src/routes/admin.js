import { randomToken, tokenHash, hashPassword, parseCookies, safeEqual, serializeCookie, verifyPassword } from "../admin/security.js";
import { validateCampaign, validateCoupon, validateCredentials } from "../admin/validation.js";
import { createAuthoritativeQuote, CheckoutValidationError } from "../domain/quote.js";
import { adminCatalog } from "../domain/catalog.js";
import { normalizeCouponCode } from "../domain/coupons.js";
import { normalizeBrazilianTaxId } from "../domain/brazilian-tax-id.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

const SESSION_COOKIE = "__Host-pulso_admin";
const CSRF_COOKIE = "pulso_admin_csrf";
const limit = (input, fallback, max) => Math.max(1, Math.min(max, Number(input) || fallback));
const customerIdPattern = /^[0-9a-f-]{36}$/i;

// Nome e documento são OPCIONAIS: o padrão é reutilizar os dados já capturados
// no pedido pago do cliente (store.getCustomerBuyerProfile). Só precisam ser
// digitados quando o cliente ainda não tem pedido com documento salvo.
function activationInput(body) {
  const customerId = String(body?.customerId ?? "").trim();
  const fullName = String(body?.fullName ?? "").trim().replace(/\s+/g, " ");
  const documentRaw = String(body?.documentNumber ?? "").trim();
  const documentNumber = documentRaw ? normalizeBrazilianTaxId(documentRaw) : null;
  const courseSlugs = Array.isArray(body?.courseSlugs)
    ? [...new Set(body.courseSlugs.map((slug) => String(slug).trim()))]
    : [];
  const catalogSlugs = new Set(adminCatalog.map((product) => product.slug));
  if (!customerIdPattern.test(customerId)) throw new Error("Selecione um cliente válido.");
  if (fullName && (fullName.length < 3 || fullName.length > 180)) throw new Error("Informe o nome completo do aluno.");
  if (documentRaw && !documentNumber) throw new Error("Informe um CPF ou CNPJ válido.");
  if (!courseSlugs.length || courseSlugs.length > adminCatalog.length || courseSlugs.some((slug) => !catalogSlugs.has(slug))) {
    throw new Error("Selecione ao menos um curso ativo do catálogo.");
  }
  return { customerId, fullName: fullName || null, documentNumber, courseSlugs };
}

function cookies(response, session, csrf, maxAge) {
  response.append("Set-Cookie", serializeCookie(SESSION_COOKIE, session, { httpOnly: true, maxAge }));
  response.append("Set-Cookie", serializeCookie(CSRF_COOKIE, csrf, { maxAge }));
}

function clearCookies(response) {
  response.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0 }));
  response.append("Set-Cookie", serializeCookie(CSRF_COOKIE, "", { maxAge: 0 }));
}

export function createAdminRouter(express, { environment, store, queue }) {
  const router = express.Router();
  const authLimiter = createFixedWindowLimiter({ windowMs: 10 * 60_000, max: 12 });
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (!environment.sessionPepper) return response.status(503).json({ error: "admin_not_configured" });
    return next();
  });
  async function requireAdmin(request, response, next) {
    const raw = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!raw) return response.status(401).json({ error: "unauthenticated" });
    const session = await store.getSession(tokenHash(raw, environment.sessionPepper));
    if (!session) return response.status(401).json({ error: "unauthenticated" });
    request.admin = session.admin; request.adminSession = session; request.adminSessionToken = raw;
    return next();
  }
  function requireCsrf(request, response, next) {
    const sent = request.get("X-CSRF-Token"); const cookie = parseCookies(request.headers.cookie)[CSRF_COOKIE];
    if (!sent || !cookie || !safeEqual(sent, cookie) || !safeEqual(tokenHash(sent, environment.sessionPepper), request.adminSession.csrfHash)) return response.status(403).json({ error: "csrf_invalid" });
    return next();
  }
  async function audit(request, action, entityType, entityId, metadata = {}) { await store.audit({ adminId: request.admin?.id ?? null, action, entityType, entityId, metadata }); }

  router.post("/bootstrap", authLimiter, async (request, response) => {
    if (!environment.adminBootstrapToken || !safeEqual(request.body?.token ?? "", environment.adminBootstrapToken)) return response.status(403).json({ error: "bootstrap_denied" });
    if (await store.countAdmins()) return response.status(409).json({ error: "bootstrap_complete" });
    try { const { email, password } = validateCredentials(request.body); const credentials = await hashPassword(password); const admin = await store.createAdmin({ email, passwordSalt: credentials.salt, passwordHash: credentials.hash }); await store.audit({ action: "admin.bootstrap", entityType: "admin", entityId: admin.id }); return response.status(201).json({ id: admin.id, email: admin.email }); } catch (error) { return response.status(400).json({ error: "invalid_admin", message: error.message }); }
  });
  router.post("/login", authLimiter, async (request, response) => {
    try { const { email, password } = validateCredentials(request.body); const admin = await store.getAdminByEmail(email); if (!admin || !(await verifyPassword(password, admin))) return response.status(401).json({ error: "invalid_credentials" }); const sessionToken = randomToken(); const csrfToken = randomToken(); await store.createSession({ adminId: admin.id, tokenHash: tokenHash(sessionToken, environment.sessionPepper), csrfHash: tokenHash(csrfToken, environment.sessionPepper), expiresAt: Date.now() + environment.sessionTtlSeconds * 1000 }); cookies(response, sessionToken, csrfToken, environment.sessionTtlSeconds); await store.audit({ adminId: admin.id, action: "admin.login", entityType: "session", entityId: null }); return response.json({ authenticated: true, admin: { id: admin.id, email: admin.email }, csrfToken }); } catch (error) { return response.status(400).json({ error: "invalid_credentials", message: error.message }); }
  });
  router.get("/session", requireAdmin, (request, response) => response.json({
    authenticated: true,
    admin: request.admin,
    csrfToken: parseCookies(request.headers.cookie)[CSRF_COOKIE] ?? null,
  }));
  router.post("/logout", requireAdmin, requireCsrf, async (request, response) => { await store.revokeSession(tokenHash(request.adminSessionToken, environment.sessionPepper)); await audit(request, "admin.logout", "session", null); clearCookies(response); response.status(204).end(); });
  router.get("/coupons", requireAdmin, async (_request, response) => response.json({ coupons: await store.listCoupons() }));
  router.get("/products", requireAdmin, (_request, response) => response.json({ products: adminCatalog }));
  router.post("/coupons", requireAdmin, requireCsrf, async (request, response) => { try { const value = validateCoupon(request.body); if (await store.getCoupon(value.code)) return response.status(409).json({ error: "coupon_exists" }); const saved = await store.saveCoupon(value); await audit(request, "coupon.create", "coupon", saved.code); return response.status(201).json({ coupon: saved }); } catch (error) { return response.status(400).json({ error: "invalid_coupon", message: error.message }); } });
  router.patch("/coupons/:code", requireAdmin, requireCsrf, async (request, response) => { const current = await store.getCoupon(normalizeCouponCode(request.params.code)); if (!current) return response.status(404).json({ error: "coupon_not_found" }); try { const saved = await store.saveCoupon(validateCoupon({ ...request.body, code: current.code }, current)); await audit(request, "coupon.update", "coupon", saved.code); return response.json({ coupon: saved }); } catch (error) { return response.status(400).json({ error: "invalid_coupon", message: error.message }); } });
  router.delete("/coupons/:code", requireAdmin, requireCsrf, async (request, response) => { const code = normalizeCouponCode(request.params.code); if (!(await store.archiveCoupon(code))) return response.status(404).json({ error: "coupon_not_found" }); await audit(request, "coupon.archive", "coupon", code); return response.status(204).end(); });
  router.get("/campaign", requireAdmin, async (_request, response) => response.json({ campaign: await store.getCampaign() }));
  router.put("/campaign", requireAdmin, requireCsrf, async (request, response) => { try { const codes = (await store.listCoupons()).filter((c) => c.active).map((c) => c.code); const campaign = await store.saveCampaign(validateCampaign(request.body, codes)); await audit(request, "campaign.update", "campaign", "public"); return response.json({ campaign }); } catch (error) { return response.status(400).json({ error: "invalid_campaign", message: error.message }); } });
  router.get("/overview", requireAdmin, async (_request, response) => response.json(await store.overview()));
  router.get("/finance", requireAdmin, async (_request, response) => response.json({ series: await store.finance() }));
  router.get("/orders", requireAdmin, async (request, response) => response.json({ orders: await store.listOrders({ limit: limit(request.query.limit, 50, 100), status: request.query.status }) }));
  router.get("/customers", requireAdmin, async (request, response) => response.json({ customers: await store.listCustomers({ limit: limit(request.query.limit, 100, 200) }) }));
  router.get("/audit", requireAdmin, async (request, response) => response.json({ events: await store.listAudit({ limit: limit(request.query.limit, 100, 200) }) }));
  router.get("/enrollments", requireAdmin, async (request, response) => response.json({ enrollments: await store.listEnrollmentJobs({ limit: limit(request.query.limit, 50, 100), status: request.query.status }) }));
  router.get("/enrollments/:id", requireAdmin, async (request, response) => { const enrollment = await store.getEnrollmentJob(request.params.id); if (!enrollment) return response.status(404).json({ error: "enrollment_not_found" }); response.json({ enrollment }); });
  router.post("/enrollments/:id/requeue", requireAdmin, requireCsrf, async (request, response) => { const requeued = await store.requeueEnrollmentJob(request.params.id); if (!requeued) return response.status(409).json({ error: "enrollment_not_requeueable" }); if (queue) queue.wake(); await audit(request, "enrollment.requeue", "enrollment", request.params.id); const enrollment = await store.getEnrollmentJob(request.params.id); response.json({ enrollment }); });
  router.post("/course-activations", requireAdmin, requireCsrf, async (request, response) => {
    if (!queue?.enqueueManualActivation) return response.status(503).json({ error: "enrollment_unavailable", message: "A integração de matrículas ainda não está disponível." });
    let input;
    try {
      input = activationInput(request.body);
    } catch (error) {
      return response.status(400).json({ error: "invalid_activation", message: error.message });
    }
    const customer = await store.getCustomerById(input.customerId);
    if (!customer) return response.status(404).json({ error: "customer_not_found", message: "Cliente não encontrado." });
    const profile = typeof store.getCustomerBuyerProfile === "function"
      ? await store.getCustomerBuyerProfile(customer.id)
      : null;
    const fullName = input.fullName || profile?.fullName || customer.displayName;
    const documentNumber = input.documentNumber || profile?.documentNumber || null;
    if (!documentNumber) {
      return response.status(400).json({
        error: "buyer_document_missing",
        message: "Este cliente ainda não tem um pedido com CPF/CNPJ salvo; informe o documento manualmente.",
      });
    }
    const activation = await queue.enqueueManualActivation({
      customerId: customer.id,
      email: customer.email,
      cpf: documentNumber,
      fullName,
      courseSlugs: input.courseSlugs,
    });
    if (!activation.created) {
      return response.status(409).json({
        error: "courses_already_activated",
        message: "Os cursos selecionados já possuem uma ativação em andamento ou concluída para este cliente.",
        activation,
      });
    }
    await audit(request, "course_activation.create", "customer", customer.id, {
      courseSlugs: input.courseSlugs,
      enrollmentIds: activation.enrollmentIds,
      skipped: activation.skipped,
    });
    return response.status(201).json({
      activation: {
        ...activation,
        customer: { id: customer.id, email: customer.email, displayName: customer.displayName },
        buyer: { fullName, documentLast4: documentNumber.slice(-4), fromOrder: !input.documentNumber },
      },
    });
  });
  return router;
}

export function createPublicCommerceRouter(express, { store }) {
  const router = express.Router(); const limiter = createFixedWindowLimiter();
  router.get("/campaign", async (_request, response) => { const campaign = await store.getCampaign(); const activeCouponCode = campaign.activeCouponCode; const coupon = activeCouponCode ? await store.getEligibleCoupon(activeCouponCode, []) : null; response.json({ campaign: coupon ? { activeCouponCode: coupon.code, discountBps: coupon.discountBps, headline: campaign.headline } : { activeCouponCode: null, discountBps: null, headline: campaign.headline } }); });
  router.post("/quote", limiter, async (request, response) => { try { const slugs = request.body?.slugs; const code = normalizeCouponCode(request.body?.couponCode); const stored = code && Array.isArray(slugs) ? await store.getEligibleCoupon(code, [...new Set(slugs)]) : null; const quote = createAuthoritativeQuote({ slugs, couponCode: code }, { coupon: stored }); response.json({ coupon: quote.coupon ? { code: quote.coupon.code, discountBps: quote.coupon.discountBps } : null, lines: quote.lines.map((line) => ({ slug: line.product.slug, title: line.product.title, basePriceCents: line.basePriceCents, discountCents: line.discountCents, finalPriceCents: line.finalPriceCents })), subtotalCents: quote.subtotalCents, discountCents: quote.discountCents, totalCents: quote.totalCents }); } catch (error) { const status = error instanceof CheckoutValidationError ? 400 : 500; response.status(status).json({ error: error.code ?? "quote_unavailable", message: error.message }); } });
  return router;
}
