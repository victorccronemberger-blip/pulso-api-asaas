await Promise.all([
  import("../src/application.js"),
  import("../src/config/environment.js"),
  import("../src/domain/catalog.js"),
  import("../src/domain/quote.js"),
  import("../src/integrations/appmax/client.js"),
  import("../src/routes/appmax-integration.js"),
  import("../src/routes/checkout.js"),
  import("../src/routes/health.js"),
]);

console.log("PULSO API source validated.");
