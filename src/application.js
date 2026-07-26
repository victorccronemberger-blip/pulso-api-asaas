import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getEnvironment } from "./config/environment.js";
import { createAppmaxClient } from "./integrations/appmax/client.js";
import {
  createAppmaxValidationHandler,
  createAppmaxWebhookHandler,
} from "./routes/appmax-integration.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createHealthRouter } from "./routes/health.js";

export function createApp(overrides = {}, dependencies = {}) {
  const environment = getEnvironment({ ...process.env, ...overrides });
  const appmaxClient = dependencies.appmaxClient ?? createAppmaxClient(environment);
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({
    origin: environment.publicOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Idempotency-Key"],
    maxAge: 86_400,
  }));
  app.use(express.json({ limit: "32kb" }));

  app.use("/health", createHealthRouter(express, environment));
  app.post(
    "/v1/integrations/appmax/validate",
    createAppmaxValidationHandler({ environment }),
  );
  app.post(
    "/v1/webhooks/appmax",
    createAppmaxWebhookHandler({ environment, appmaxClient }),
  );
  app.use("/v1/checkout", createCheckoutRouter(express, { environment, appmaxClient }));

  app.use((_request, response) => {
    response.status(404).json({
      error: "not_found",
      message: "Esta API está reservada para os serviços do PULSO.",
    });
  });

  return { app, environment, appmaxClient };
}
