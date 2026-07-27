import { createApp } from "./application.js";

const { app, environment, ready } = createApp();
const server = app.listen(environment.port, environment.host, () => {
  console.log(`PULSO API listening on ${environment.host}:${environment.port}`);
});

ready
  .then(() => {
    console.log("PULSO API persistent store is ready.");
  })
  .catch((error) => {
    console.error("PULSO API could not initialize its persistent store.", {
      code: error?.code,
      errno: error?.errno,
      sqlState: error?.sqlState,
      message: error?.message,
      type: error?.name,
    });
  });

function shutdown(signal) {
  console.log(`PULSO API received ${signal}.`);
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
