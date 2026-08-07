import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getEnvironment } from "./config/environment.js";
import { createAsaasClient } from "./integrations/asaas/client.js";
import { createAsaasWebhookHandler } from "./routes/asaas-integration.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createHealthRouter } from "./routes/health.js";
import { createPublicCommerceRouter } from "./routes/public.js";
import { createInMemoryStore } from "./store/in-memory-store.js";
import { createMySqlStore } from "./store/mysql-store.js";
import { createInstallmentService } from "./services/installment-service.js";
import { replaceCatalogProducts } from "./domain/catalog.js";
import { requestContext } from "./http/request-context.js";
import { jsonErrorHandler } from "./http/error-handler.js";

export function createApp(overrides = {}, dependencies = {}) {
  const environment = getEnvironment({ ...process.env, ...overrides });
  if (environment.nodeEnvironment === "production" && !environment.mysqlUrl) {
    throw new Error("MYSQL_URL is required in production.");
  }
  if (environment.nodeEnvironment === "production" && environment.checkoutEnabled && !environment.asaasWebhookToken) {
    throw new Error("ASAAS_WEBHOOK_TOKEN is required when checkout is enabled in production.");
  }
  const asaasClient = dependencies.asaasClient ?? createAsaasClient(environment);
  const store = dependencies.store ?? (environment.mysqlUrl ? createMySqlStore(environment.mysqlUrl) : createInMemoryStore());
  const installmentService = dependencies.installmentService
    ?? createInstallmentService({ asaasClient, store });
  // Pagamento confirmado: registra a concessão de acesso. A entrega do curso
  // acontece na plataforma frontend (LMS em pulso.cyara.com.br); aqui o evento
  // é apenas auditado em log para fechamento com o financeiro.
  const onAccessGranted = async (orderId) => {
    console.log("PULSO API payment confirmed; access granted.", { orderId });
  };

  const app = express();
  const allowedOrigins = [...new Set([
    environment.publicOrigin,
    "https://academy.cyara.com.br",
  ])];
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

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(requestContext);
  app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Idempotency-Key", "asaas-access-token", "x-pulso-trusted-token"],
    maxAge: 86_400,
  }));
  app.use(express.json({ limit: "32kb" }));

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
  app.use("/v1/public", createPublicCommerceRouter(express, { store }));

  app.use((_request, response) => {
    response.status(404).json({
      error: "not_found",
      message: "Esta API é reservada aos serviços de pagamento do PULSO.",
    });
  });
  app.use(jsonErrorHandler);

  return { app, environment, asaasClient, installmentService, store, readiness, ready, waitForReady };
}
