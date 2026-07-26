import { createApp } from "./application.js";

const { app, environment } = createApp();

const server = app.listen(environment.port, environment.host, () => {
  console.log(`PULSO API listening on ${environment.host}:${environment.port}`);
});

function shutdown(signal) {
  console.log(`PULSO API received ${signal}.`);
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
