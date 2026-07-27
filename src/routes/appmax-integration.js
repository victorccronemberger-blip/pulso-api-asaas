function validAppId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createAppmaxValidationHandler({ environment }) {
  return function appmaxValidation(request, response) {
    const appId = validAppId(request.body?.app_id);
    if (!appId) {
      response.status(400).json({ error: "invalid_app_id" });
      return;
    }
    if (environment.appmaxAppNumericalId && appId !== environment.appmaxAppNumericalId) {
      response.status(403).json({ error: "unexpected_app_id" });
      return;
    }
    response.json({
      external_id: environment.appmaxExternalId,
      alias: "PULSO Bancário",
    });
  };
}

export function createAppmaxWebhookHandler({ environment, appmaxClient, store }) {
  return function appmaxWebhook(request, response) {
    const appId = validAppId(request.body?.app_id);
    const event = String(request.body?.event ?? request.body?.event_type ?? "").trim();
    const orderId = validAppId(
      request.body?.data?.order_id
      ?? request.body?.data?.order?.id
      ?? request.body?.data?.id,
    );

    if (!appId || !event) {
      response.status(400).json({ error: "invalid_webhook" });
      return;
    }
    if (environment.appmaxAppNumericalId && appId !== environment.appmaxAppNumericalId) {
      response.status(403).json({ error: "unexpected_app_id" });
      return;
    }

    response.json({ received: true });

    if (orderId && appmaxClient) {
      void appmaxClient.getOrder(orderId)
        .then(async (result) => {
          const status = String(result?.data?.order?.status ?? "unknown").toLowerCase();
          const mapped = ["aprovado", "integrado", "pendente_integracao", "pendente_integracao_em_analise"].includes(status) ? "paid"
            : status === "pendente" ? "open" : status === "estornado" ? "refunded" : ["cancelado", "recusado_por_risco"].includes(status) ? "failed" : "processing";
          await store?.updateOrderFromWebhook({
            appmaxOrderId: orderId,
            status: mapped,
            eventId: `${event}:${orderId}:${status}`,
          });
          console.info("Verified Appmax webhook", {
            appId,
            event,
            orderId,
            status: result?.data?.order?.status ?? "unknown",
          });
        })
        .catch((error) => {
          console.error("Could not verify Appmax webhook", {
            appId,
            event,
            orderId,
            status: error?.status,
          });
        });
    }
  };
}
