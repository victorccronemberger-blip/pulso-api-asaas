import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getEnvironment } from "./config/environment.js";
import { createAsaasClient } from "./integrations/asaas/client.js";
import { createAsaasWebhookHandler } from "./routes/asaas-integration.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createHealthRouter } from "./routes/health.js";
import { createAdminRouter, createPublicCommerceRouter } from "./routes/admin.js";
import { createInMemoryStore } from "./admin/in-memory-store.js";
import { createMySqlStore } from "./admin/mysql-store.js";

export function createApp(overrides = {}, dependencies = {}) {
  const environment = getEnvironment({ ...process.env, ...overrides });
  if (environment.nodeEnvironment === "production" && !environment.mysqlUrl) {
    throw new Error("MYSQL_URL is required in production.");
  }
  const asaasClient = dependencies.asaasClient ?? createAsaasClient(environment);
  const store = dependencies.store ?? (environment.mysqlUrl ? createMySqlStore(environment.mysqlUrl) : createInMemoryStore());
  const app = express();
  const readiness = {
    status: "connecting",
    error: null,
  };
  const ready = Promise.resolve()
    .then(() => store.ensureSchema())
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
  app.use(cors({
    origin: [environment.publicOrigin, environment.adminOrigin, environment.sitesOrigin],
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Idempotency-Key", "X-CSRF-Token", "asaas-access-token"],
    credentials: true,
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
    createAsaasWebhookHandler({ environment, store }),
  );
  app.use("/v1/checkout", createCheckoutRouter(express, { environment, asaasClient, store }));
  app.use("/v1/admin", createAdminRouter(express, { environment, store }));
  app.use("/v1/public", createPublicCommerceRouter(express, { store }));

  app.use((_request, response) => {
    response.status(404).json({
      error: "not_found",
      message: "Esta API está reservada para os serviços do PULSO.",
    });
  });

  return { app, environment, asaasClient, store, readiness, ready, waitForReady };
}
