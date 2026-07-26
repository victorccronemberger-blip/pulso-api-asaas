import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getEnvironment } from "./config/environment.js";
import { createStripeClient } from "./integrations/stripe/client.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createHealthRouter } from "./routes/health.js";
import { createStripeWebhookHandler } from "./routes/stripe-webhook.js";
import { handleStripeEvent } from "./services/stripe-events.js";

export function createApp(overrides = {}, dependencies = {}) {
  const environment = getEnvironment({ ...process.env, ...overrides });
  const stripeClient = dependencies.stripeClient ?? createStripeClient(environment);
  const onStripeEvent = dependencies.onStripeEvent ?? handleStripeEvent;
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
  app.post(
    "/v1/webhooks/stripe",
    express.raw({ type: "application/json", limit: "256kb" }),
    createStripeWebhookHandler({ environment, stripeClient, onStripeEvent }),
  );
  app.use(express.json({ limit: "32kb" }));

  app.use("/health", createHealthRouter(express, environment));
  app.use("/v1/checkout", createCheckoutRouter(express, { environment, stripeClient }));

  app.use((_request, response) => {
    response.status(404).json({
      error: "not_found",
      message: "Esta API está reservada para os serviços do PULSO.",
    });
  });

  return { app, environment, stripeClient };
}
