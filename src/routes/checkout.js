import { createHash } from "node:crypto";
import {
  MAX_INTEREST_FREE_INSTALLMENTS,
  createInterestFreeInstallments,
  interestFreeInstallment,
} from "../domain/installments.js";
import { CheckoutValidationError, createAuthoritativeQuote } from "../domain/quote.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

const PAID_STATUSES = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
const FAILED_STATUSES = new Set(["OVERDUE"]);
const REFUNDED_STATUSES = new Set(["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS"]);
const CHARGEBACK_STATUSES = new Set([
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "AWAITING_CHARGEBACK_REVERSAL",
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
    name: `${cleanText(input.firstName, 2, 80, "Nome")} ${cleanText(input.lastName, 2, 100, "Sobrenome")}`,
    email,
    mobilePhone: cleanDigits(input.phone, 10, 13, "Telefone"),
    cpfCnpj: cleanDigits(input.documentNumber, 11, 14, "CPF ou CNPJ"),
    ip,
  };
}

function parsePayment(input) {
  if (!input || typeof input !== "object") throw new CheckoutInputError("Meio de pagamento inválido.");
  if (input.method === "pix") return { method: "pix", installments: 1 };
  if (!["pix_installment", "credit_card"].includes(input.method)) {
    throw new CheckoutInputError("Meio de pagamento inválido.");
  }
  const installments = Number(input.installments);
  if (
    !Number.isSafeInteger(installments)
    || installments < (input.method === "pix_installment" ? 2 : 1)
    || installments > MAX_INTEREST_FREE_INSTALLMENTS
  ) {
    throw new CheckoutInputError("Número de parcelas inválido.", "invalid_installments");
  }
  return { method: input.method, installments };
}

async function quoteFromBody(body, store) {
  const slugs = body?.slugs;
  const couponCode = body?.couponCode;
  const normalized = typeof couponCode === "string" ? couponCode.trim().toUpperCase().replace(/\s+/g, "") : null;
  const coupon = normalized && Array.isArray(slugs)
    ? await store?.getEligibleCoupon(normalized, [...new Set(slugs)])
    : null;
  return createAuthoritativeQuote({ slugs, couponCode }, store ? { coupon } : {});
}

export function asaasOrderStatus(value) {
  const status = String(value ?? "").trim().toUpperCase();
  if (PAID_STATUSES.has(status)) return "paid";
  if (status === "PENDING") return "open";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (REFUNDED_STATUSES.has(status)) return "refunded";
  if (CHARGEBACK_STATUSES.has(status)) return "chargeback";
  return "processing";
}

function providerId(value, label = "payment id") {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new Error(`Asaas returned no ${label}.`);
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

function amount(cents) {
  return Number((cents / 100).toFixed(2));
}

function dueDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function findOrCreateCustomer(asaasClient, buyer, key) {
  const existing = await asaasClient.findCustomersByDocument(buyer.cpfCnpj);
  const match = Array.isArray(existing?.data) ? existing.data.find((customer) => customer?.id) : null;
  if (match) return providerId(match.id, "customer id");
  const created = await asaasClient.createCustomer({
    name: buyer.name,
    cpfCnpj: buyer.cpfCnpj,
    email: buyer.email,
    mobilePhone: buyer.mobilePhone,
    externalReference: `pulso-customer:${key}`,
  });
  return providerId(created?.id, "customer id");
}

function paymentPayload({ customerId, quote, payment, key }) {
  const pixMethod = payment.method === "pix" || payment.method === "pix_installment";
  const payload = {
    customer: customerId,
    billingType: pixMethod ? "PIX" : "CREDIT_CARD",
    dueDate: dueDate(),
    description: quote.lines.map((line) => line.product.title).join(" + ").slice(0, 500),
    externalReference: `pulso:${key}`,
  };
  if (payment.installments > 1) {
    return {
      ...payload,
      installmentCount: payment.installments,
      totalValue: amount(quote.totalCents),
    };
  }
  return { ...payload, value: amount(quote.totalCents) };
}

function paymentCallbackPayload(providerPayment, successUrl) {
  const billingType = String(providerPayment?.billingType ?? "").trim().toUpperCase();
  const value = Number(providerPayment?.value);
  const paymentDueDate = String(providerPayment?.dueDate ?? "").trim();
  if (
    !["UNDEFINED", "BOLETO", "CREDIT_CARD", "PIX"].includes(billingType)
    || !Number.isFinite(value)
    || value <= 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDueDate)
  ) {
    throw new Error("Asaas returned incomplete payment data for callback configuration.");
  }

  const payload = {
    billingType,
    value,
    dueDate: paymentDueDate,
    callback: {
      successUrl,
      autoRedirect: true,
    },
  };
  const description = String(providerPayment?.description ?? "").trim();
  const externalReference = String(providerPayment?.externalReference ?? "").trim();
  if (description) payload.description = description;
  if (externalReference) payload.externalReference = externalReference;
  return payload;
}

export function createCheckoutRouter(express, { environment, asaasClient, store }) {
  const router = express.Router();
  const limiter = createFixedWindowLimiter();

  function requireProvider(response) {
    if (environment.checkoutEnabled && asaasClient) return true;
    response.status(503).json({
      error: "checkout_unavailable",
      message: "A conta de pagamentos ainda precisa ser conectada.",
    });
    return false;
  }

  router.get("/status", (_request, response) => {
    response.json({
      enabled: environment.checkoutEnabled,
      provider: "asaas",
      environment: environment.asaasEnvironment,
      methods: environment.checkoutEnabled ? ["pix", "pix_installment", "credit_card"] : [],
      cardMode: "hosted_invoice",
      pixInstallmentMode: "monthly_manual_payment",
      pixAutomatic: false,
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
      response.status(409).json({ error: "idempotency_in_progress", message: "Esta tentativa ainda está sendo processada." });
      return;
    }

    if (quote.coupon) {
      const reserved = await store.reserveCoupon(
        quote.coupon.code,
        key,
        quote.lines.map((line) => line.product.slug),
      );
      if (!reserved) {
        const result = { status: 400, body: { error: "invalid_coupon", message: "Cupom inválido ou indisponível.", retryable: true } };
        await store.abandonCheckoutAttempt(key);
        response.status(result.status).json(result.body);
        return;
      }
      quote = createAuthoritativeQuote({ slugs: request.body?.slugs, couponCode: quote.coupon.code }, { coupon: reserved });
    }

    let couponReservationBound = false;
    let persistedOrderId = null;
    let result;
    try {
      if (payment.installments > 1 && !interestFreeInstallment(quote.totalCents, payment.installments)) {
        throw new CheckoutInputError("O parcelamento escolhido não está disponível.", "invalid_installments");
      }

      const customerId = await findOrCreateCustomer(asaasClient, buyer, key);
      const providerPayment = await asaasClient.createPayment(paymentPayload({
        customerId,
        quote,
        payment,
        key,
      }));
      const orderId = providerId(providerPayment?.id);
      persistedOrderId = orderId;

      const successUrl = `${environment.publicOrigin}/checkout/sucesso/?order_id=${encodeURIComponent(orderId)}`;
      let updatedPayment = providerPayment;
      try {
        updatedPayment = await asaasClient.updatePayment(
          orderId,
          paymentCallbackPayload(providerPayment, successUrl),
        );
      } catch (callbackError) {
        console.error("Could not configure the Asaas return URL", {
          orderId,
          status: callbackError?.status,
          code: callbackError?.code,
        });
      }
      const invoiceUrl = String(updatedPayment?.invoiceUrl ?? providerPayment?.invoiceUrl ?? "").trim();

      await store.createOrder({
        provider: "asaas",
        providerOrderId: orderId,
        providerGroupId: providerPayment?.installment
          ? providerId(providerPayment.installment, "installment id")
          : null,
        checkoutAttemptKey: quote.coupon ? key : null,
        status: asaasOrderStatus(updatedPayment?.status ?? providerPayment?.status),
        buyerEmail: buyer.email,
        couponCode: quote.coupon?.code ?? null,
        subtotalCents: quote.subtotalCents,
        discountCents: quote.discountCents,
        totalCents: quote.totalCents,
        lines: quote.lines,
      });
      couponReservationBound = Boolean(quote.coupon);

      if (payment.method === "pix" || payment.method === "pix_installment") {
        const pix = await asaasClient.getPixQrCode(orderId);
        if (typeof pix?.encodedImage !== "string" || typeof pix?.payload !== "string") {
          throw new Error("Asaas returned incomplete Pix instructions.");
        }
        const installment = interestFreeInstallment(quote.totalCents, payment.installments);
        result = {
          status: 201,
          body: {
            orderId,
            status: asaasOrderStatus(updatedPayment?.status ?? providerPayment?.status),
            method: payment.method,
            installments: payment.installments,
            installmentCents: installment?.installmentCents ?? quote.totalCents,
            totalCents: quote.totalCents,
            pix: { qrCodeBase64: pix.encodedImage, emv: pix.payload, expiresAt: pix.expirationDate ?? null },
          },
        };
      } else {
        if (!/^https:\/\/(?:www\.)?asaas\.com\//i.test(invoiceUrl) && !/^https:\/\/sandbox\.asaas\.com\//i.test(invoiceUrl)) {
          throw new Error("Asaas returned no secure invoice URL.");
        }
        result = {
          status: 201,
          body: {
            orderId,
            status: asaasOrderStatus(updatedPayment?.status ?? providerPayment?.status),
            method: "credit_card",
            installments: payment.installments,
            totalCents: quote.totalCents,
            redirectUrl: invoiceUrl,
          },
        };
      }
    } catch (error) {
      if (error instanceof CheckoutInputError) {
        if (quote.coupon) await store.releaseCouponReservation(key);
        await store.abandonCheckoutAttempt(key);
        result = { status: 400, body: { error: error.code, message: error.message, retryable: true } };
      } else {
        if (quote.coupon && !couponReservationBound) await store.releaseCouponReservation(key);
        if (!persistedOrderId) await store.abandonCheckoutAttempt(key);
        console.error("Asaas checkout failed", {
          endpoint: error?.endpoint,
          status: error?.status,
          code: error?.code,
          type: error?.name,
        });
        result = persistedOrderId ? {
          status: 202,
          body: {
            orderId: persistedOrderId,
            status: "processing",
            method: payment.method,
            totalCents: quote.totalCents,
            message: "Pedido recebido e em reconciliação com a Asaas.",
          },
        } : {
          status: 502,
          body: {
            error: "checkout_provider_error",
            message: error?.retryable
              ? "A Asaas está temporariamente indisponível. Tente novamente."
              : "O pagamento não pôde ser criado. Revise os dados e tente novamente.",
            retryable: true,
          },
        };
      }
    }

    await store.completeCheckoutAttempt(key, result);
    response.status(result.status).json(result.body);
  });

  router.get("/orders/:orderId", limiter, async (request, response) => {
    if (!requireProvider(response)) return;
    let orderId;
    try {
      orderId = providerId(request.params.orderId);
      const payment = await asaasClient.getPayment(orderId);
      response.json({ id: providerId(payment?.id ?? orderId), status: asaasOrderStatus(payment?.status) });
    } catch (error) {
      console.error("Asaas payment retrieval failed", {
        endpoint: error?.endpoint,
        status: error?.status,
      });
      response.status(error?.status === 404 ? 404 : 502).json({
        error: "order_not_found",
        message: "Não encontramos este pedido na Asaas.",
      });
    }
  });

  return router;
}
