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
  validateCustomerActionToken,
  validateCustomerCredentials,
  validateCustomerEmail,
  validateCustomerPasswordChange,
  validateCustomerPasswordReset,
  validateCustomerProfile,
  validateCustomerRegistration,
} from "../customer/validation.js";
import { parseCookies } from "../admin/security.js";
import { publicInstallmentPlan } from "../services/installment-service.js";
import { Readable } from "node:stream";
import { bunnyMaterialUrl, createBunnyPlaybackUrl } from "../learning/bunny.js";

const ORDER_ID = /^[0-9a-f-]{36}$/i;
const LEARNING_ID = /^[a-z0-9][a-z0-9-]{1,95}$/i;

export function createCustomerRouter(express, {
  customerMailer,
  environment,
  installmentService,
  store,
}) {
  const router = express.Router();
  const limiter = createFixedWindowLimiter();
  const pepper = environment.sessionPepper;
  const ttlSeconds = environment.sessionTtlSeconds;
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  async function withInstallmentPlan(order) {
    if (!order || order.paymentMethod !== "pix_installment") return order;
    const rows = await store.listPaymentInstallments(order.id);
    return {
      ...order,
      pixInstallmentPlan: publicInstallmentPlan(rows, order.installments),
    };
  }

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

  async function issueActionToken(customer, kind, ttlMilliseconds) {
    const token = randomToken();
    await store.createCustomerActionToken({
      customerId: customer.id,
      kind,
      tokenHash: tokenHash(token, pepper),
      expiresAt: Date.now() + ttlMilliseconds,
    });
    return token;
  }

  async function sendVerification(customer) {
    const token = await issueActionToken(customer, "verify_email", 24 * 60 * 60_000);
    await customerMailer.sendEmailVerification({ customer, token });
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
    let customer;
    try {
      customer = await store.createCustomer({
        email: input.email,
        displayName: input.displayName,
        passwordSalt: credentials.salt,
        passwordHash: credentials.hash,
      });
    } catch (error) {
      if (error?.code !== "ER_DUP_ENTRY") throw error;
      response.status(409).json({
        error: "customer_exists",
        message: "Este e-mail já possui uma conta. Entre com sua senha.",
      });
      return;
    }
    const csrfToken = await createSession(response, customer.id);
    if (customerMailer.available) {
      sendVerification(customer).catch((error) => {
        console.error("Could not send customer email verification", {
          customerId: customer.id,
          type: error?.name,
        });
      });
    }
    response.status(201).json({
      authenticated: true,
      csrfToken,
      customer: publicCustomer(customer),
    });
  });

  router.post("/password/forgot", limiter, async (request, response) => {
    const input = validateCustomerEmail(request.body);
    if (!input) {
      response.status(400).json({
        error: "invalid_email",
        message: "Informe um e-mail válido.",
      });
      return;
    }
    if (!customerMailer.available) {
      response.status(503).json({
        error: "transactional_email_unavailable",
        message: "A recuperação por e-mail está temporariamente indisponível.",
      });
      return;
    }
    const customer = await store.getCustomerByEmail(input.email);
    if (customer) {
      try {
        const token = await issueActionToken(customer, "reset_password", 30 * 60_000);
        await customerMailer.sendPasswordReset({ customer, token });
      } catch (error) {
        console.error("Could not send customer password reset", {
          customerId: customer.id,
          type: error?.name,
        });
      }
    }
    response.status(202).json({
      accepted: true,
      message: "Se o e-mail estiver cadastrado, você receberá um link de recuperação.",
    });
  });

  router.post("/password/reset", limiter, async (request, response) => {
    const input = validateCustomerPasswordReset(request.body);
    if (!input) {
      response.status(400).json({
        error: "invalid_password_reset",
        message: "Use um link válido e uma senha com pelo menos 12 caracteres.",
      });
      return;
    }
    const action = await store.consumeCustomerActionToken({
      kind: "reset_password",
      tokenHash: tokenHash(input.token, pepper),
    });
    if (!action) {
      response.status(400).json({
        error: "expired_password_reset",
        message: "Este link expirou ou já foi utilizado.",
      });
      return;
    }
    const credentials = await hashPassword(input.newPassword);
    await store.updateCustomerPassword(action.customerId, {
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash,
    });
    await store.markCustomerEmailVerified(action.customerId);
    await store.revokeCustomerSessions(action.customerId);
    response.json({ changed: true, reauthenticate: true });
  });

  router.post("/email-verification/confirm", limiter, async (request, response) => {
    const token = validateCustomerActionToken(request.body);
    const action = token ? await store.consumeCustomerActionToken({
      kind: "verify_email",
      tokenHash: tokenHash(token, pepper),
    }) : null;
    if (!action) {
      response.status(400).json({
        error: "expired_email_verification",
        message: "Este link expirou ou já foi utilizado.",
      });
      return;
    }
    const customer = await store.markCustomerEmailVerified(action.customerId);
    response.json({ verified: true, customer: publicCustomer(customer) });
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

  router.post("/email-verification/request", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!requireCsrf(request, response, session)) return;
    if (session.customer.emailVerifiedAt) {
      response.json({ sent: false, alreadyVerified: true });
      return;
    }
    if (!customerMailer.available) {
      response.status(503).json({
        error: "transactional_email_unavailable",
        message: "A confirmação por e-mail está temporariamente indisponível.",
      });
      return;
    }
    await sendVerification(session.customer);
    response.status(202).json({ sent: true });
  });

  router.patch("/profile", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!requireCsrf(request, response, session)) return;
    const profile = validateCustomerProfile(request.body);
    if (!profile) {
      response.status(400).json({
        error: "invalid_customer_profile",
        message: "Informe um nome válido e um telefone com DDD.",
      });
      return;
    }
    const customer = await store.updateCustomerProfile(session.customer.id, profile);
    response.json({ customer: publicCustomer(customer) });
  });

  router.post("/password", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!requireCsrf(request, response, session)) return;
    const input = validateCustomerPasswordChange(request.body);
    const customer = input ? await store.getCustomerByEmail(session.customer.email) : null;
    if (!input || !customer || !(await verifyPassword(input.currentPassword, customer))) {
      response.status(400).json({
        error: "invalid_password_change",
        message: "Confira a senha atual e use uma nova senha com pelo menos 12 caracteres.",
      });
      return;
    }
    const credentials = await hashPassword(input.newPassword);
    await store.updateCustomerPassword(session.customer.id, {
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash,
    });
    await store.revokeCustomerSessions(session.customer.id);
    clearCustomerCookies(response);
    response.json({ changed: true, reauthenticate: true });
  });

  router.get("/orders", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    const orders = await store.listCustomerOrders(session.customer.id, { limit: 50 });
    response.json({ orders: await Promise.all(orders.map(withInstallmentPlan)) });
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
    response.json({ order: await withInstallmentPlan(order) });
  });

  router.post("/orders/:orderId/installments/refresh", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!requireCsrf(request, response, session)) return;
    if (!ORDER_ID.test(request.params.orderId)) {
      response.status(404).json({ error: "order_not_found", message: "Pedido não encontrado." });
      return;
    }
    const order = await store.getCustomerOrderForSync(
      session.customer.id,
      request.params.orderId,
    );
    if (!order || order.paymentMethod !== "pix_installment") {
      response.status(404).json({ error: "installment_plan_not_found", message: "Parcelamento não encontrado." });
      return;
    }
    try {
      const pixInstallmentPlan = await installmentService.sync(order);
      response.json({ pixInstallmentPlan });
    } catch (error) {
      console.error("Could not refresh Asaas installment plan", {
        orderId: order.id,
        code: error?.code,
        type: error?.name,
      });
      response.status(502).json({
        error: "installment_refresh_failed",
        message: "Não foi possível atualizar as parcelas agora.",
      });
    }
  });

  router.get("/learning/courses", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    response.json({ courses: await store.listCustomerLearningCourses(session.customer.id) });
  });

  router.get("/learning/courses/:courseSlug", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!LEARNING_ID.test(request.params.courseSlug)) {
      response.status(404).json({ error: "course_not_found", message: "Curso não encontrado." });
      return;
    }
    const course = await store.getCustomerLearningCourse(session.customer.id, request.params.courseSlug);
    if (!course) {
      response.status(404).json({ error: "course_not_found", message: "Este curso não está liberado nesta conta." });
      return;
    }
    response.json({ course });
  });

  router.get("/learning/courses/:courseSlug/lessons/:lessonId/playback", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!LEARNING_ID.test(request.params.courseSlug) || !LEARNING_ID.test(request.params.lessonId)) {
      response.status(404).json({ error: "lesson_not_found", message: "Aula não encontrada." });
      return;
    }
    const lesson = await store.getCustomerLearningLesson(session.customer.id, request.params.courseSlug, request.params.lessonId);
    if (!lesson) {
      response.status(404).json({ error: "lesson_not_found", message: "Esta aula não está liberada nesta conta." });
      return;
    }
    const playback = createBunnyPlaybackUrl(environment, lesson.bunnyVideoId);
    if (!playback) {
      response.status(503).json({ error: "playback_unavailable", message: "O vídeo está sendo preparado. Tente novamente em instantes." });
      return;
    }
    response.json({
      lesson: {
        id: lesson.id,
        title: lesson.title,
        durationSeconds: lesson.durationSeconds,
        positionSeconds: lesson.positionSeconds,
        completed: lesson.completed,
      },
      playback,
    });
  });

  router.patch("/learning/courses/:courseSlug/lessons/:lessonId/progress", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!requireCsrf(request, response, session)) return;
    if (!LEARNING_ID.test(request.params.courseSlug) || !LEARNING_ID.test(request.params.lessonId)) {
      response.status(404).json({ error: "lesson_not_found", message: "Aula não encontrada." });
      return;
    }
    const positionSeconds = Number(request.body?.positionSeconds);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0 || positionSeconds > 86_400) {
      response.status(400).json({ error: "invalid_progress", message: "Progresso inválido." });
      return;
    }
    const progress = await store.saveCustomerLessonProgress(
      session.customer.id,
      request.params.courseSlug,
      request.params.lessonId,
      { positionSeconds, completed: request.body?.completed === true },
    );
    if (!progress) {
      response.status(404).json({ error: "lesson_not_found", message: "Aula não encontrada." });
      return;
    }
    response.json({ progress });
  });

  router.get("/learning/courses/:courseSlug/lessons/:lessonId/material", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!LEARNING_ID.test(request.params.courseSlug) || !LEARNING_ID.test(request.params.lessonId)) {
      response.status(404).json({ error: "material_not_found", message: "Material não encontrado." });
      return;
    }
    const lesson = await store.getCustomerLearningLesson(session.customer.id, request.params.courseSlug, request.params.lessonId);
    const materialUrl = bunnyMaterialUrl(environment, lesson?.materialPath);
    if (!lesson || !materialUrl) {
      response.status(404).json({ error: "material_not_found", message: "Esta aula não possui material disponível." });
      return;
    }
    const upstream = await fetch(materialUrl, {
      headers: { AccessKey: environment.bunnyStorageAccessKey, accept: "application/pdf" },
    });
    if (!upstream.ok || !upstream.body) {
      response.status(502).json({ error: "material_unavailable", message: "Não foi possível abrir o material agora." });
      return;
    }
    response.set("Content-Type", upstream.headers.get("content-type") || "application/pdf");
    response.set("Content-Disposition", `inline; filename="${request.params.lessonId}.pdf"`);
    const length = upstream.headers.get("content-length");
    if (length) response.set("Content-Length", length);
    Readable.fromWeb(upstream.body).pipe(response);
  });

  router.get("/learning/quizzes/:quizId", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!LEARNING_ID.test(request.params.quizId)) {
      response.status(404).json({ error: "quiz_not_found", message: "Simulado não encontrado." });
      return;
    }
    const quiz = await store.getCustomerLearningQuiz(session.customer.id, request.params.quizId);
    if (!quiz) {
      response.status(404).json({ error: "quiz_not_found", message: "Este simulado não está liberado nesta conta." });
      return;
    }
    response.json({ quiz });
  });

  router.post("/learning/quizzes/:quizId/submit", limiter, async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!requireCsrf(request, response, session)) return;
    if (!LEARNING_ID.test(request.params.quizId) || !Array.isArray(request.body?.answers) || request.body.answers.length > 100) {
      response.status(400).json({ error: "invalid_quiz_answers", message: "Confira as respostas enviadas." });
      return;
    }
    const result = await store.submitCustomerLearningQuiz(session.customer.id, request.params.quizId, request.body.answers);
    if (!result) {
      response.status(404).json({ error: "quiz_not_found", message: "Simulado não encontrado." });
      return;
    }
    response.status(201).json({ result });
  });

  router.get("/learning/courses/:courseSlug/attempts", async (request, response) => {
    const session = await requireSession(request, response);
    if (!session) return;
    if (!LEARNING_ID.test(request.params.courseSlug) || !await store.hasCustomerCourseAccess(session.customer.id, request.params.courseSlug)) {
      response.status(404).json({ error: "course_not_found", message: "Curso não encontrado." });
      return;
    }
    response.json({ attempts: await store.listCustomerLearningAttempts(session.customer.id, request.params.courseSlug) });
  });

  return router;
}
