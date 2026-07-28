import {
  hashPassword,
  randomToken,
  tokenHash,
  verifyPassword,
} from "../admin/security.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import {
  clearCustomerCookies,
  CUSTOMER_SESSION_COOKIE,
  customerSessionFromRequest,
  setCustomerCookies,
  validCustomerCsrf,
} from "../customer/session.js";
import {
  publicCustomer,
  validateCustomerCredentials,
  validateCustomerRegistration,
} from "../customer/validation.js";
import { parseCookies } from "../admin/security.js";

const ORDER_ID = /^[0-9a-f-]{36}$/i;

export function createCustomerRouter(express, { environment, store }) {
  const router = express.Router();
  const limiter = createFixedWindowLimiter();
  const pepper = environment.sessionPepper;
  const ttlSeconds = environment.sessionTtlSeconds;

  async function requireSession(request, response) {
    const session = await customerSessionFromRequest(request, store, pepper);
    if (!session) {
      response.status(401).json({
        error: "customer_authentication_required",
        message: "Entre na sua conta para continuar.",
      });
      return null;
    }
    return session;
  }

  function requireCsrf(request, response, session) {
    if (validCustomerCsrf(request, session, pepper)) return true;
    response.status(403).json({
      error: "invalid_csrf",
      message: "Sua sessão precisa ser atualizada.",
    });
    return false;
  }

  async function createSession(response, customerId) {
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    await store.createCustomerSession({
      customerId,
      tokenHash: tokenHash(sessionToken, pepper),
      csrfHash: tokenHash(csrfToken, pepper),
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    setCustomerCookies(response, sessionToken, csrfToken, ttlSeconds);
    return csrfToken;
  }

  router.post("/register", limiter, async (request, response) => {
    const input = validateCustomerRegistration(request.body);
    if (!input) {
      response.status(400).json({
        error: "invalid_registration",
        message: "Informe nome, e-mail válido e uma senha com pelo menos 12 caracteres.",
      });
      return;
    }
    if (await store.getCustomerByEmail(input.email)) {
      response.status(409).json({
        error: "customer_exists",
        message: "Este e-mail já possui uma conta. Entre com sua senha.",
      });
      return;
    }
    const credentials = await hashPassword(input.password);
    const customer = await store.createCustomer({
      email: input.email,
      displayName: input.displayName,
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash,
    });
    const csrfToken = await createSession(response, customer.id);
    response.status(201).json({
      authenticated: true,
      csrfToken,
      customer: publicCustomer(customer),
    });
  });

  router.post("/login", limiter, async (request, response) => {
    const input = validateCustomerCredentials(request.body);
    const customer = input ? await store.getCustomerByEmail(input.email) : null;
    if (!customer || !(await verifyPassword(input.password, customer))) {
      response.status(401).json({
        error: "invalid_customer_credentials",
        message: "E-mail ou senha incorretos.",
      });
      return;
    }
    const csrfToken = await createSession(response, customer.id);
    response.json({
      authenticated: true,
      csrfToken,
      customer: publicCustomer(customer),
    });
  });

  router.get("/session", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    const cookies = parseCookies(request.get("cookie"));
    response.json({
      authenticated: true,
      csrfToken: cookies.pulso_customer_csrf ?? null,
      customer: publicCustomer(session.customer),
    });
  });

  router.post("/logout", async (request, response) => {
    const session = await customerSessionFromRequest(request, store, pepper);
    if (!session) {
      clearCustomerCookies(response);
      response.status(204).end();
      return;
    }
    if (!requireCsrf(request, response, session)) return;
    const token = parseCookies(request.get("cookie"))[CUSTOMER_SESSION_COOKIE];
    if (token) await store.revokeCustomerSession(tokenHash(token, pepper));
    clearCustomerCookies(response);
    response.status(204).end();
  });

  router.get("/orders", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    const orders = await store.listCustomerOrders(session.customer.id, { limit: 50 });
    response.json({ orders });
  });

  router.get("/orders/:orderId", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!ORDER_ID.test(request.params.orderId)) {
      response.status(404).json({ error: "order_not_found", message: "Pedido não encontrado." });
      return;
    }
    const order = await store.getCustomerOrder(session.customer.id, request.params.orderId);
    if (!order) {
      response.status(404).json({ error: "order_not_found", message: "Pedido não encontrado." });
      return;
    }
    response.json({ order });
  });

  return router;
}
