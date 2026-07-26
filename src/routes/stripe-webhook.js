export function createStripeWebhookHandler({
  environment,
  stripeClient,
  onStripeEvent,
}) {
  return async function stripeWebhook(request, response) {
    if (!environment.webhookConfigured || !stripeClient) {
      response.status(503).json({ error: "webhook_not_configured" });
      return;
    }

    const signature = request.get("Stripe-Signature");
    if (!signature) {
      response.status(400).json({ error: "missing_signature" });
      return;
    }

    let event;
    try {
      event = stripeClient.webhooks.constructEvent(
        request.body,
        signature,
        environment.stripeWebhookSecret,
      );
    } catch {
      response.status(400).json({ error: "invalid_signature" });
      return;
    }

    try {
      await onStripeEvent(event);
      response.json({ received: true });
    } catch (error) {
      console.error("Stripe webhook processing failed", {
        eventId: event.id,
        type: event.type,
        error: error instanceof Error ? error.message : "unknown",
      });
      response.status(500).json({ error: "webhook_processing_failed" });
    }
  };
}
