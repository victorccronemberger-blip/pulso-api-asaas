export function createHealthRouter(express, environment) {
  const router = express.Router();

  router.get("/", (_request, response) => {
    response.json({
      status: "ok",
      service: "pulso-api",
      capabilities: {
        checkout: environment.checkoutEnabled,
      },
    });
  });

  return router;
}
