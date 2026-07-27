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
  return async function appmaxWebhook(request, response) {
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

    if (!orderId || !appmaxClient || !store) return response.status(503).json({ error: "webhook_unavailable" });
    try {
      const result = await appmaxClient.getOrder(orderId);
      const status = String(result?.data?.order?.status ?? "unknown").toLowerCase();
      const mapped = ["aprovado", "integrado", "pendente_integracao", "pendente_integracao_em_analise"].includes(status) ? "paid"
        : status === "pendente" ? "open" : status === "estornado" ? "refunded"
          : ["chargeback", "chargeback_em_analise", "chargeback_ganho", "chargeback_perdido"].includes(status) ? "chargeback"
            : ["cancelado", "recusado_por_risco"].includes(status) ? "failed" : "processing";
      const persisted = await store.updateOrderFromWebhook({ appmaxOrderId: orderId, status: mapped, eventId: `${event}:${orderId}:${status}` });
      if (persisted?.missing) throw new Error("Webhook order is not persisted yet.");
      console.info("Verified Appmax webhook", { appId, event, orderId, status });
      return response.json({ received: true });
    } catch (error) {
      console.error("Could not verify or persist Appmax webhook", { appId, event, orderId, status: error?.status, type: error?.name });
      return response.status(502).json({ error: "webhook_retry" });
    }
  };
}
