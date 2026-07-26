const handledEventTypes = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

export async function handleStripeEvent(event) {
  if (!handledEventTypes.has(event.type)) return;
  const object = event.data?.object;
  console.info("Stripe event received", {
    eventId: event.id,
    type: event.type,
    objectId: object?.id,
    paymentStatus: object?.payment_status,
  });
}
