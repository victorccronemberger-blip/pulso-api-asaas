await Promise.all([
  import("../src/application.js"),
  import("../src/config/environment.js"),
  import("../src/routes/health.js"),
]);

console.log("PULSO API source validated.");
