import { randomUUID } from "node:crypto";
import { CheckoutValidationError, createAuthoritativeQuote } from "../domain/quote.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

function idempotencyKey(request) {
  const provided = request.get("Idempotency-Key")?.trim();
  if (provided && /^[A-Za-z0-9_-]{16,128}$/.test(provided)) return provided;
  return randomUUID();
}

function publicSessionStatus(session) {
  if (session.payment_status === "paid") return "paid";
  if (session.status === "expired") return "expired";
  if (session.status === "complete") return "processing";
  return "open";
}

export function createCheckoutRouter(express, { environment, stripeClient }) {
  const router = express.Router();
  const limiter = createFixedWindowLimiter();

  router.get("/status", (_request, response) => {
    response.json({ enabled: environment.checkoutEnabled });
  });

  router.post("/sessions", limiter, async (request, response) => {
    if (!environment.checkoutEnabled || !stripeClient) {
      response.status(503).json({
        error: "checkout_unavailable",
        message: "A conta de pagamentos ainda precisa ser conectada.",
      });
      return;
    }

    let quote;
    try {
      quote = createAuthoritativeQuote(request.body);
    } catch (error) {
      if (error instanceof CheckoutValidationError) {
        response.status(400).json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }

    const cartId = randomUUID();
    const courseSlugs = quote.lines.map((line) => line.product.slug).join(",");
    const metadata = {
      pulso_cart_id: cartId,
      course_slugs: courseSlugs,
      coupon_code: quote.coupon?.code ?? "none",
      coupon_version: quote.coupon?.version ?? "none",
      subtotal_cents: String(quote.subtotalCents),
      discount_cents: String(quote.discountCents),
      total_cents: String(quote.totalCents),
    };

    try {
      const session = await stripeClient.checkout.sessions.create({
        mode: "payment",
        ui_mode: "hosted",
        locale: "pt-BR",
        client_reference_id: cartId,
        customer_creation: "always",
        billing_address_collection: "auto",
        success_url: `${environment.publicOrigin}/checkout/sucesso/?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${environment.publicOrigin}/carrinho/?checkout=cancelado`,
        line_items: quote.lines.map((line) => ({
          quantity: 1,
          price_data: {
            currency: "brl",
            unit_amount: line.finalPriceCents,
            product_data: {
              name: line.product.title,
              description: line.product.description,
              images: [`${environment.publicOrigin}/media/pulso/v4/cards/600/${line.product.slug}.webp`],
              metadata: {
                course_slug: line.product.slug,
                original_unit_amount: String(line.basePriceCents),
                discounted_unit_amount: String(line.finalPriceCents),
              },
            },
          },
        })),
        metadata,
        payment_intent_data: { metadata },
        custom_text: {
          submit: {
            message: "O acesso será enviado após a confirmação do pagamento.",
          },
        },
      }, {
        idempotencyKey: `pulso:${idempotencyKey(request)}`,
      });

      if (!session.url) throw new Error("Stripe Checkout returned no URL.");
      response.status(201).json({ url: session.url });
    } catch (error) {
      console.error("Stripe Checkout session creation failed", {
        type: error?.type,
        code: error?.code,
        requestId: error?.requestId,
      });
      response.status(502).json({
        error: "checkout_provider_error",
        message: "O pagamento não pôde ser iniciado. Tente novamente em instantes.",
      });
    }
  });

  router.get("/sessions/:sessionId", async (request, response) => {
    if (!environment.stripeAvailable || !stripeClient) {
      response.status(503).json({
        error: "checkout_unavailable",
        message: "A confirmação do pagamento está temporariamente indisponível.",
      });
      return;
    }

    const { sessionId } = request.params;
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) {
      response.status(400).json({ error: "invalid_session", message: "Sessão inválida." });
      return;
    }

    try {
      const session = await stripeClient.checkout.sessions.retrieve(sessionId);
      response.json({
        id: session.id,
        status: publicSessionStatus(session),
      });
    } catch (error) {
      console.error("Stripe Checkout session retrieval failed", {
        type: error?.type,
        code: error?.code,
        requestId: error?.requestId,
      });
      response.status(404).json({
        error: "session_not_found",
        message: "Não encontramos esta sessão de pagamento.",
      });
    }
  });

  return router;
}
