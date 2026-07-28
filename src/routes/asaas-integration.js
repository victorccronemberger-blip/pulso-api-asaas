import { timingSafeEqual } from "node:crypto";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";
import { normalizeProviderInstallment } from "../services/installment-service.js";

function safeEqual(received, expected) {
  const left = Buffer.from(String(received ?? ""), "utf8");
  const right = Buffer.from(String(expected ?? ""), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function paymentId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{6,80}$/.test(id) ? id : null;
}

export function createAsaasWebhookHandler({ environment, store }) {
  return async function asaasWebhook(request, response) {
    if (!environment.asaasWebhookToken) {
      response.status(503).json({ error: "webhook_not_configured" });
      return;
    }
    if (!safeEqual(request.get("asaas-access-token"), environment.asaasWebhookToken)) {
      response.status(401).json({ error: "invalid_webhook_token" });
      return;
    }

    const event = String(request.body?.event ?? "").trim().toUpperCase();
    const eventId = String(request.body?.id ?? "").trim();
    const payment = request.body?.payment;
    const orderId = paymentId(payment?.id);
    const providerGroupId = paymentId(payment?.installment);
    const externalReference = String(payment?.externalReference ?? "").trim();
    if (
      !/^PAYMENT_[A-Z_]+$/.test(event)
      || !/^[A-Za-z0-9_&.-]{6,128}$/.test(eventId)
      || !orderId
      || !externalReference.startsWith("pulso:")
    ) {
      response.status(400).json({ error: "invalid_webhook" });
      return;
    }

    try {
      let persisted;
      if (providerGroupId) {
        const installment = normalizeProviderInstallment(payment);
        if (!installment) {
          response.status(400).json({ error: "invalid_installment_webhook" });
          return;
        }
        persisted = await store.updatePaymentInstallmentFromWebhook({
          provider: "asaas",
          providerOrderId: orderId,
          providerGroupId,
          installment,
          eventId,
        });
      } else {
        persisted = await store.updateOrderFromWebhook({
          provider: "asaas",
          providerOrderId: orderId,
          providerGroupId: null,
          status: normalizeAsaasPaymentStatus(payment?.status),
          eventId,
        });
      }
      response.status(200).json({ received: true, duplicate: Boolean(persisted?.duplicate) });
    } catch (error) {
      console.error("Could not persist Asaas webhook", {
        event,
        orderId,
        type: error?.name,
      });
      response.status(500).json({ error: "webhook_processing_failed" });
    }
  };
}
