import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getEnvironment } from "./config/environment.js";
import { createHealthRouter } from "./routes/health.js";

export function createApp(overrides = {}) {
  const environment = getEnvironment({ ...process.env, ...overrides });
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin: environment.publicOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    maxAge: 86_400,
  }));
  app.use(express.json({ limit: "32kb" }));

  app.use("/health", createHealthRouter(express, environment));

  app.use((_request, response) => {
    response.status(404).json({
      error: "not_found",
      message: "Esta API está reservada para os serviços do PULSO.",
    });
  });

  return { app, environment };
}
