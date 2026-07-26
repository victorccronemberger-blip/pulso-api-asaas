import { createHash } from "node:crypto";
import { CheckoutValidationError, createAuthoritativeQuote } from "../domain/quote.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;
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

function parseBuyer(input) {
  if (!input || typeof input !== "object") throw new CheckoutInputError("Dados do comprador inválidos.");
  const email = String(input.email ?? "").trim().toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CheckoutInputError("E-mail inválido.");
  }
  const ip = String(input.ip ?? "").trim();
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
  if (!Number.isSafeInteger(installments) || installments < 1 || installments > 12) {
    throw new CheckoutInputError("Número de parcelas inválido.", "invalid_installments");
  }
  return {
    method: "credit_card",
    token,
    installments,
    holderName: cleanText(input.holderName, 3, 120, "Nome no cartão"),
  };
}

function quoteFromBody(body) {
  return createAuthoritativeQuote({
    slugs: body?.slugs,
    couponCode: body?.couponCode,
  });
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

function publicInstallments(result, baseTotalCents) {
  const source = result?.data?.installments;
  if (!source || typeof source !== "object") {
    return [{ number: 1, totalCents: baseTotalCents, installmentCents: baseTotalCents }];
  }
  const maximum = Math.min(12, Number(result?.data?.settings?.max_installments) || 12);
  const minimum = Math.max(1, Number(result?.data?.settings?.min_installment_value) || 1);
  const options = Object.entries(source)
    .map(([key, value]) => {
      const number = Number(key);
      const totalCents = Number(value?.total);
      return {
        number,
        totalCents,
        installmentCents: Number.isSafeInteger(totalCents) ? Math.ceil(totalCents / number) : 0,
      };
    })
    .filter((option) => (
      Number.isSafeInteger(option.number)
      && option.number >= 1
      && option.number <= maximum
      && Number.isSafeInteger(option.totalCents)
      && option.totalCents >= baseTotalCents
      && option.installmentCents >= minimum
    ))
    .sort((a, b) => a.number - b.number);
  return options.length
    ? options
    : [{ number: 1, totalCents: baseTotalCents, installmentCents: baseTotalCents }];
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
    response.status(400).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export function createCheckoutRouter(express, { environment, appmaxClient }) {
  const router = express.Router();
  const limiter = createFixedWindowLimiter();
  const attempts = new Map();

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
      quote = quoteFromBody(request.body);
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }

    try {
      const result = await appmaxClient.getInstallments({
        installments: 12,
        total_value: quote.totalCents,
        settings: true,
      });
      response.json({
        baseTotalCents: quote.totalCents,
        installments: publicInstallments(result, quote.totalCents),
      });
    } catch (error) {
      console.error("Appmax installment calculation failed", {
        endpoint: error?.endpoint,
        status: error?.status,
      });
      response.status(502).json({
        error: "checkout_provider_error",
        message: "Não foi possível consultar o parcelamento agora.",
      });
    }
  });

  router.post("/orders", limiter, async (request, response) => {
    if (!requireProvider(response)) return;

    let key;
    let quote;
    let buyer;
    let payment;
    try {
      key = idempotencyKey(request);
      quote = quoteFromBody(request.body);
      buyer = parseBuyer(request.body?.buyer);
      payment = parsePayment(request.body?.payment);
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }

    const fingerprint = checkoutFingerprint(request.body);
    const existing = attempts.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.fingerprint !== fingerprint) {
        response.status(409).json({
          error: "idempotency_conflict",
          message: "Esta tentativa já foi usada com outro pedido.",
        });
        return;
      }
      const replay = await existing.promise;
      response.status(replay.status).json(replay.body);
      return;
    }

    for (const [attemptKey, attempt] of attempts) {
      if (attempt.expiresAt <= Date.now()) attempts.delete(attemptKey);
    }

    const promise = (async () => {
      try {
        let chargedTotalCents = quote.totalCents;
        if (payment.method === "credit_card") {
          const installmentsResult = await appmaxClient.getInstallments({
            installments: payment.installments,
            total_value: quote.totalCents,
            settings: true,
          });
          const options = publicInstallments(installmentsResult, quote.totalCents);
          const chosen = options.find((option) => option.number === payment.installments);
          if (!chosen) {
            return {
              status: 400,
              body: {
                error: "invalid_installments",
                message: "O parcelamento escolhido não está disponível.",
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
          ...(payment.method === "pix" || payment.installments === 1
            ? { unit_value: line.finalPriceCents }
            : {}),
        }));
        const orderResult = await appmaxClient.createOrder({
          customer_id: customerId,
          ...(payment.method === "credit_card" && payment.installments > 1
            ? { products_value: chargedTotalCents }
            : {}),
          products,
        });
        const order = appmaxOrder(orderResult);
        const orderId = integerId(order?.id, "order id");

        if (payment.method === "pix") {
          const pixResult = await appmaxClient.createPixPayment({
            order_id: orderId,
            payment_data: { pix: { document_number: buyer.documentNumber } },
          });
          const pix = appmaxPayment(pixResult);
          if (typeof pix?.pix_qrcode !== "string" || typeof pix?.pix_emv !== "string") {
            throw new Error("Appmax returned incomplete Pix instructions.");
          }
          return {
            status: 201,
            body: {
              orderId,
              status: orderStatus(appmaxOrder(pixResult)?.status ?? order?.status),
              method: "pix",
              totalCents: chargedTotalCents,
              pix: { qrCodeBase64: pix.pix_qrcode, emv: pix.pix_emv },
            },
          };
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
        return {
          status: 201,
          body: {
            orderId,
            status: orderStatus(appmaxOrder(cardResult)?.status ?? order?.status),
            method: "credit_card",
            installments: payment.installments,
            totalCents: chargedTotalCents,
          },
        };
      } catch (error) {
        console.error("Appmax checkout failed", {
          endpoint: error?.endpoint,
          status: error?.status,
          type: error?.name,
        });
        return {
          status: 502,
          body: {
            error: "checkout_provider_error",
            message: "O pagamento não pôde ser processado. Revise os dados e tente novamente.",
          },
        };
      }
    })();

    attempts.set(key, {
      fingerprint,
      promise,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
    const result = await promise;
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
