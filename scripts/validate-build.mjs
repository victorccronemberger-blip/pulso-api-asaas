await Promise.all([
  import("../src/application.js"),
  import("../src/admin/in-memory-store.js"),
  import("../src/admin/mysql-store.js"),
  import("../src/admin/security.js"),
  import("../src/admin/validation.js"),
  import("../src/config/environment.js"),
  import("../src/domain/catalog.js"),
  import("../src/domain/quote.js"),
  import("../src/integrations/appmax/client.js"),
  import("../src/routes/appmax-integration.js"),
  import("../src/routes/admin.js"),
  import("../src/routes/checkout.js"),
  import("../src/routes/health.js"),
]);

console.log("PULSO API source validated.");
