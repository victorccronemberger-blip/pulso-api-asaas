import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getEnvironment } from "./config/environment.js";
import { createAsaasClient } from "./integrations/asaas/client.js";
import { createArtIntegration } from "./integrations/art/index.js";
import { createCustomerMailer } from "./integrations/email/mailer.js";
import { createAsaasWebhookHandler } from "./routes/asaas-integration.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createHealthRouter } from "./routes/health.js";
import { createAdminRouter, createPublicCommerceRouter } from "./routes/admin.js";
import { createCustomerRouter } from "./routes/customer.js";
import { createInMemoryStore } from "./admin/in-memory-store.js";
import { createMySqlStore } from "./admin/mysql-store.js";
import { createInstallmentService } from "./services/installment-service.js";
import { replaceCatalogProducts } from "./domain/catalog.js";
import { requestContext } from "./http/request-context.js";
import { jsonErrorHandler } from "./http/error-handler.js";

export function createApp(overrides = {}, dependencies = {}) {
  const environment = getEnvironment({ ...process.env, ...overrides });
  if (environment.nodeEnvironment === "production" && !environment.mysqlUrl) {
    throw new Error("MYSQL_URL is required in production.");
  }
  if (environment.nodeEnvironment === "production" && !environment.sessionPepper) {
    throw new Error("SESSION_PEPPER is required in production.");
  }
  if (environment.nodeEnvironment === "production" && environment.checkoutEnabled && !environment.asaasWebhookToken) {
    throw new Error("ASAAS_WEBHOOK_TOKEN is required when checkout is enabled in production.");
  }
  const asaasClient = dependencies.asaasClient ?? createAsaasClient(environment);
  const customerMailer = dependencies.customerMailer ?? createCustomerMailer(environment);
  const store = dependencies.store ?? (environment.mysqlUrl ? createMySqlStore(environment.mysqlUrl) : createInMemoryStore());
  const installmentService = dependencies.installmentService
    ?? createInstallmentService({ asaasClient, store });
  const artIntegration = dependencies.artIntegration ?? createArtIntegration({ environment, store });
  // Concessão de acesso pós-pagamento. Sem a integração de matrícula ligada
  // (ENROLLMENT_ENABLED!=true), registra em log cada pedido pago que ficou
  // pendente de ativação manual em vez de falhar em silêncio.
  const onAccessGranted = artIntegration
    ? async (orderId) => {
        const order = await store.getOrderWithItems(orderId);
        await artIntegration.queue.enqueueOrder(order);
      }
    : async (orderId) => {
        console.error("PULSO API payment confirmed but automatic enrollment is DISABLED (ENROLLMENT_ENABLED!=true); manual activation required.", { orderId });
      };
  const app = express();
  const readiness = {
    status: "connecting",
    error: null,
  };
  const ready = Promise.resolve()
    .then(() => store.ensureSchema())
    .then(() => store.listCatalogProducts())
    .then((products) => {
      if (products.length) replaceCatalogProducts(products);
      else if (environment.nodeEnvironment === "production") throw new Error("O catálogo de produtos do banco está vazio.");
      return store;
    })
    .then(() => {
      readiness.status = "ready";
      return store;
    })
    .catch((error) => {
      readiness.status = "error";
      readiness.error = error?.code || error?.name || "database_initialization_failed";
      throw error;
    });
  const waitForReady = () => {
    if (readiness.status !== "connecting") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2_000);
      const settle = () => {
        clearTimeout(timeout);
        resolve();
      };
      ready.then(settle, settle);
    });
  };
  if (artIntegration) {
    ready.then(() => artIntegration.queue.start()).catch((error) => {
      console.error("PULSO API enrollment queue failed to start.", { message: error?.message });
    });
  }

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(requestContext);
  app.use(cors({
    origin: [environment.publicOrigin, environment.adminOrigin, environment.sitesOrigin],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Idempotency-Key", "X-CSRF-Token", "asaas-access-token"],
    credentials: true,
    maxAge: 86_400,
  }));
  app.use(express.json({ limit: "32kb" }));

  const adminPanelUrl = new URL("/admin/", environment.adminOrigin).toString();
  app.get(["/admin", "/admin/"], (_request, response) => {
    response.redirect(308, adminPanelUrl);
  });

  app.use("/health", createHealthRouter(express, environment, readiness, waitForReady));
  app.use(async (_request, response, next) => {
    await waitForReady();
    if (readiness.status === "ready") return next();
    return response.status(503).json({
      error: "service_initializing",
      message: "O serviço de dados do PULSO ainda não está disponível.",
    });
  });
  app.post(
    "/v1/webhooks/asaas",
    createAsaasWebhookHandler({ environment, store, onAccessGranted }),
  );
  app.use("/v1/checkout", createCheckoutRouter(express, {
    environment,
    asaasClient,
    installmentService,
    store,
    onAccessGranted,
  }));
  app.use("/v1/customer", createCustomerRouter(express, {
    customerMailer,
    environment,
    installmentService,
    store,
  }));
  app.use("/v1/admin", createAdminRouter(express, { environment, store, queue: artIntegration?.queue }));
  app.use("/v1/public", createPublicCommerceRouter(express, { store }));

  app.use((_request, response) => {
    response.status(404).json({
      error: "not_found",
      message: "Esta API está reservada para os serviços do PULSO.",
    });
  });
  app.use(jsonErrorHandler);

  return { app, environment, asaasClient, customerMailer, installmentService, artIntegration, store, readiness, ready, waitForReady };
}
