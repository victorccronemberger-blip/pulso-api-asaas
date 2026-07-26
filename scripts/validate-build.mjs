await Promise.all([
  import("../src/application.js"),
  import("../src/config/environment.js"),
  import("../src/domain/catalog.js"),
  import("../src/domain/quote.js"),
  import("../src/integrations/stripe/client.js"),
  import("../src/routes/checkout.js"),
  import("../src/routes/health.js"),
  import("../src/routes/stripe-webhook.js"),
]);

console.log("PULSO API source validated.");
