import { createHash } from "node:crypto";
import {
  MAX_INTEREST_FREE_INSTALLMENTS,
  createInterestFreeInstallments,
  interestFreeInstallment,
} from "../domain/installments.js";
import { CheckoutValidationError, createAuthoritativeQuote } from "../domain/quote.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

const PAID_STATUSES = new Set([
  "aprovado",
  "integrado",
  "pendente_integracao",
  "pendente_integracao_em_analise",
]);
const FAILED_STATUSES = new Set(["cancelado", "recusado_por_risco"]);
const REFUNDED_STATUSES = new Set(["estornado"]);
const CHARGEBACK_STATUSES = new Set([
  "chargeback",
  "chargeback_em_analise",
  "chargeback_ganho",
  "chargeback_perdido",
]);

class CheckoutInputError extends Error {
  constructor(message, code = "invalid_checkout") {
    super(message);
    this.name = "CheckoutInputError";
    this.code = code;
  }
}

function cleanDigits(value, min, max, label) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < min || digits.length > max) {
    throw new CheckoutInputError(`${label} inválido.`);
  }
  return digits;
}

function cleanText(value, min, max, label) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length < min || text.length > max) {
    throw new CheckoutInputError(`${label} inválido.`);
  }
  return text;
}

function parseBuyer(input, requestIp) {
  if (!input || typeof input !== "object") throw new CheckoutInputError("Dados do comprador inválidos.");
  const email = String(input.email ?? "").trim().toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CheckoutInputError("E-mail inválido.");
  }
  const ip = String(requestIp ?? "").replace(/^::ffff:/, "").trim();
  if (ip.length < 3 || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip)) {
    throw new CheckoutInputError("Não foi possível validar a conexão do comprador.", "invalid_customer_ip");
  }
  return {
    firstName: cleanText(input.firstName, 2, 80, "Nome"),
    lastName: cleanText(input.lastName, 2, 100, "Sobrenome"),
    email,
    phone: cleanDigits(input.phone, 10, 13, "Telefone"),
    documentNumber: cleanDigits(input.documentNumber, 11, 14, "CPF ou CNPJ"),
    ip,
  };
}

function parsePayment(input) {
  if (!input || typeof input !== "object") throw new CheckoutInputError("Meio de pagamento inválido.");
  if (input.method === "pix") return { method: "pix" };
  if (input.method !== "credit_card") throw new CheckoutInputError("Meio de pagamento inválido.");

  const token = String(input.token ?? "").trim();
  if (!/^[A-Za-z0-9._-]{16,256}$/.test(token)) {
    throw new CheckoutInputError("Token de cartão inválido.", "invalid_card_token");
  }
  const installments = Number(input.installments);
  if (
    !Number.isSafeInteger(installments)
    || installments < 1
    || installments > MAX_INTEREST_FREE_INSTALLMENTS
  ) {
    throw new CheckoutInputError("Número de parcelas inválido.", "invalid_installments");
  }
  return {
    method: "credit_card",
    token,
    installments,
    holderName: cleanText(input.holderName, 3, 120, "Nome no cartão"),
  };
}

async function quoteFromBody(body, store) {
  const slugs = body?.slugs;
  const couponCode = body?.couponCode;
  const normalized = typeof couponCode === "string" ? couponCode.trim().toUpperCase().replace(/\s+/g, "") : null;
  const coupon = normalized && Array.isArray(slugs)
    ? await store?.getEligibleCoupon(normalized, [...new Set(slugs)])
    : null;
  return createAuthoritativeQuote({
    slugs,
    couponCode,
  }, store ? { coupon } : {});
}

function orderStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (PAID_STATUSES.has(status)) return "paid";
  if (status === "autorizado") return "processing";
  if (status === "pendente") return "open";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (REFUNDED_STATUSES.has(status)) return "refunded";
  if (CHARGEBACK_STATUSES.has(status)) return "chargeback";
  return "processing";
}

function appmaxOrder(result) {
  return result?.data?.order ?? result?.order ?? null;
}

function appmaxPayment(result) {
  return result?.data?.payment ?? result?.payment ?? null;
}

function integerId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Appmax returned no ${label}.`);
  return id;
}

function checkoutFingerprint(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function idempotencyKey(request) {
  const value = request.get("Idempotency-Key")?.trim();
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CheckoutInputError("Identificador da tentativa inválido.", "invalid_idempotency_key");
  }
  return value;
}

function handleInputError(error, response) {
  if (error instanceof CheckoutValidationError || error instanceof CheckoutInputError) {
    response.status(400).json({ error: error.code, message: error.message, retryable: true });
    return true;
  }
  return false;
}

export function createCheckoutRouter(express, { environment, appmaxClient, store }) {
  const router = express.Router();
  const limiter = createFixedWindowLimiter();

  function requireProvider(response) {
    if (environment.checkoutEnabled && appmaxClient) return true;
    response.status(503).json({
      error: "checkout_unavailable",
      message: "A conta de pagamentos ainda precisa ser conectada.",
    });
    return false;
  }

  router.get("/status", (_request, response) => {
    response.json({
      enabled: environment.checkoutEnabled,
      provider: "appmax",
      environment: environment.appmaxEnvironment,
      externalId: environment.checkoutEnabled ? environment.appmaxExternalId : null,
      methods: environment.checkoutEnabled ? ["pix", "credit_card"] : [],
    });
  });

  router.post("/installments", limiter, async (request, response) => {
    if (!requireProvider(response)) return;
    let quote;
    try {
      quote = await quoteFromBody(request.body, store);
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }

    response.json({
      baseTotalCents: quote.totalCents,
      maximumInstallments: MAX_INTEREST_FREE_INSTALLMENTS,
      interestFree: true,
      installments: createInterestFreeInstallments(quote.totalCents),
    });
  });

  router.post("/orders", limiter, async (request, response) => {
    if (!requireProvider(response)) return;

    let key;
    let quote;
    let buyer;
    let payment;
    try {
      key = idempotencyKey(request);
      quote = await quoteFromBody(request.body, store);
      buyer = parseBuyer(request.body?.buyer, request.ip);
      payment = parsePayment(request.body?.payment);
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }

    const fingerprint = checkoutFingerprint(request.body);
    const attempt = await store.beginCheckoutAttempt(key, fingerprint);
    if (attempt.kind === "conflict") {
      response.status(409).json({ error: "idempotency_conflict", message: "Esta tentativa já foi usada com outro pedido.", retryable: true });
      return;
    }
    if (attempt.kind === "replay") {
      response.status(attempt.response.status).json(attempt.response.body);
      return;
    }
    if (attempt.kind === "pending") {
      response.status(409).json({ error: "idempotency_in_progress", message: "Esta tentativa ainda est\u00e1 sendo processada." });
      return;
    }
    if (quote.coupon) {
      const reserved = await store.reserveCoupon(
        quote.coupon.code,
        key,
        quote.lines.map((line) => line.product.slug),
      );
      if (!reserved) {
        const result = { status: 400, body: { error: "invalid_coupon", message: "Cupom inv\u00e1lido ou indispon\u00edvel.", retryable: true } };
        await store.abandonCheckoutAttempt(key);
        response.status(result.status).json(result.body);
        return;
      }
      quote = createAuthoritativeQuote({ slugs: request.body?.slugs, couponCode: quote.coupon.code }, { coupon: reserved });
    }

    const promise = (async () => {
      let couponReservationBound = false;
      let persistedOrderId = null;
      try {
        let chargedTotalCents = quote.totalCents;
        if (payment.method === "credit_card") {
          const chosen = interestFreeInstallment(quote.totalCents, payment.installments);
          if (!chosen) {
            if (quote.coupon) await store.releaseCouponReservation(key);
            await store.abandonCheckoutAttempt(key);
            return {
              status: 400,
              body: {
                error: "invalid_installments",
                message: "O parcelamento escolhido não está disponível.",
                retryable: true,
              },
            };
          }
          chargedTotalCents = chosen.totalCents;
        }

        const customerResult = await appmaxClient.createCustomer({
          first_name: buyer.firstName,
          last_name: buyer.lastName,
          email: buyer.email,
          phone: buyer.phone,
          document_number: buyer.documentNumber,
          ip: buyer.ip,
        });
        const customerId = integerId(
          customerResult?.data?.customer?.id ?? customerResult?.customer?.id,
          "customer id",
        );

        const products = quote.lines.map((line) => ({
          sku: line.product.slug,
          name: line.product.title,
          quantity: 1,
          type: "digital",
          unit_value: line.finalPriceCents,
        }));
        const orderResult = await appmaxClient.createOrder({
          customer_id: customerId,
          products,
        });
        const order = appmaxOrder(orderResult);
        const orderId = integerId(order?.id, "order id");
        await store?.createOrder({
          appmaxOrderId: orderId,
          checkoutAttemptKey: quote.coupon ? key : null,
          status: "created",
          buyerEmail: buyer.email,
          couponCode: quote.coupon?.code ?? null,
          subtotalCents: quote.subtotalCents,
          discountCents: quote.discountCents,
          totalCents: chargedTotalCents,
          lines: quote.lines,
        });
        persistedOrderId = orderId;
        couponReservationBound = Boolean(quote.coupon);
        if (payment.method === "pix") {
          const pixResult = await appmaxClient.createPixPayment({
            order_id: orderId,
            payment_data: { pix: { document_number: buyer.documentNumber } },
          });
          const pix = appmaxPayment(pixResult);
          if (typeof pix?.pix_qrcode !== "string" || typeof pix?.pix_emv !== "string") {
            throw new Error("Appmax returned incomplete Pix instructions.");
          }
          const result = {
            status: 201,
            body: {
              orderId,
              status: orderStatus(appmaxOrder(pixResult)?.status ?? order?.status),
              method: "pix",
              totalCents: chargedTotalCents,
              pix: { qrCodeBase64: pix.pix_qrcode, emv: pix.pix_emv },
            },
          };
          try {
            await store?.updateOrderFromWebhook({
              appmaxOrderId: orderId,
              status: result.body.status,
            });
          } catch (persistenceError) {
            console.error("Could not update the local Pix order", {
              orderId,
              type: persistenceError?.name,
            });
          }
          return result;
        }

        const cardResult = await appmaxClient.createCardPayment({
          order_id: orderId,
          customer_id: customerId,
          payment_data: {
            credit_card: {
              token: payment.token,
              holder_document_number: buyer.documentNumber,
              holder_name: payment.holderName,
              installments: payment.installments,
              soft_descriptor: environment.appmaxSoftDescriptor,
            },
          },
        });
        const result = {
          status: 201,
          body: {
            orderId,
            status: orderStatus(appmaxOrder(cardResult)?.status ?? order?.status),
            method: "credit_card",
            installments: payment.installments,
            totalCents: chargedTotalCents,
          },
        };
        try {
          await store?.updateOrderFromWebhook({
            appmaxOrderId: orderId,
            status: result.body.status,
          });
        } catch (persistenceError) {
          console.error("Could not update the local card order", {
            orderId,
            type: persistenceError?.name,
          });
        }
        return result;
      } catch (error) {
        if (quote.coupon && !couponReservationBound) {
          await store.releaseCouponReservation(key);
        }
        if (!persistedOrderId) {
          await store.abandonCheckoutAttempt(key);
        }
        console.error("Appmax checkout failed", {
          endpoint: error?.endpoint,
          status: error?.status,
          type: error?.name,
        });
        return persistedOrderId ? {
          status: 202,
          body: {
            orderId: persistedOrderId,
            status: "processing",
            method: payment.method,
            totalCents: quote.totalCents,
            message: "Pedido recebido e em reconciliação com a Appmax.",
          },
        } : {
          status: 502,
          body: {
            error: "checkout_provider_error",
            message: "O pagamento não pôde ser processado. Revise os dados e tente novamente.",
            retryable: true,
          },
        };
      }
    })();

    const result = await promise;
    await store.completeCheckoutAttempt(key, result);
    response.status(result.status).json(result.body);
  });

  router.get("/orders/:orderId", limiter, async (request, response) => {
    if (!requireProvider(response)) return;
    if (!/^[1-9]\d{0,15}$/.test(request.params.orderId)) {
      response.status(400).json({ error: "invalid_order", message: "Pedido inválido." });
      return;
    }

    try {
      const result = await appmaxClient.getOrder(request.params.orderId);
      const order = appmaxOrder(result);
      response.json({
        id: integerId(order?.id ?? request.params.orderId, "order id"),
        status: orderStatus(order?.status),
      });
    } catch (error) {
      console.error("Appmax order retrieval failed", {
        endpoint: error?.endpoint,
        status: error?.status,
      });
      response.status(error?.status === 404 ? 404 : 502).json({
        error: "order_not_found",
        message: "Não encontramos este pedido na Appmax.",
      });
    }
  });

  return router;
}
