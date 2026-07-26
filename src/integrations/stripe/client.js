import Stripe from "stripe";

export function createStripeClient(environment) {
  if (!environment.stripeSecretKey) return null;
  return new Stripe(environment.stripeSecretKey, {
    appInfo: {
      name: "PULSO API",
      version: "0.2.0",
      url: "https://pulso.cyara.com.br",
    },
  });
}
