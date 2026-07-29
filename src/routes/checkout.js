import { createHash } from "node:crypto";
import {
  MAX_INTEREST_FREE_INSTALLMENTS,
  MAX_PIX_INSTALLMENTS,
  MIN_CARD_INSTALLMENT_CENTS,
  MIN_PIX_INSTALLMENT_CENTS,
  createInterestFreeInstallments,
  interestFreeInstallment,
} from "../domain/installments.js";
import { CheckoutValidationError, createAuthoritativeQuote } from "../domain/quote.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import { customerSessionFromRequest } from "../customer/session.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";
import { providerId, safeAsaasInvoiceUrl } from "../domain/provider-values.js";

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

function hasRepeatedDigits(value) {
  return /^(\d)\1+$/.test(value);
}

function isValidCpf(value) {
  if (value.length !== 11 || hasRepeatedDigits(value)) return false;
  const calculateDigit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(value[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return calculateDigit(9) === Number(value[9])
    && calculateDigit(10) === Number(value[10]);
}

function isValidCnpj(value) {
  if (value.length !== 14 || hasRepeatedDigits(value)) return false;
  const calculateDigit = (length) => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculateDigit(12) === Number(value[12])
    && calculateDigit(13) === Number(value[13]);
}

function cleanDocument(value) {
  const document = cleanDigits(value, 11, 14, "CPF ou CNPJ");
  if (!isValidCpf(document) && !isValidCnpj(document)) {
    throw new CheckoutInputError("CPF ou CNPJ inválido.", "invalid_document");
  }
  return document;
}

function cleanText(value, min, max, label) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length < min || text.length > max) {
    throw new CheckoutInputError(`${label} inválido.`);
  }
  return text;
}

const BRAZILIAN_STATES = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

function cleanBirthDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const date = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new CheckoutInputError("Data de nascimento inválida.", "invalid_birth_date");
  }
  const year = Number(date.slice(0, 4));
  const nowYear = new Date().getUTCFullYear();
  if (year < 1900 || year > nowYear - 10) {
    throw new CheckoutInputError("Data de nascimento inválida.", "invalid_birth_date");
  }
  return date;
}

// Endereço completo do comprador. Todos opcionais na API (frontends antigos não
// enviam), mas validados quando presentes — a matrícula os usa para montar o
// perfil do aluno na plataforma de cursos sem defaults fabricados.
function cleanAddress(input) {
  if (!input || typeof input !== "object") return null;
  const digits = (value, max) => String(value ?? "").replace(/\D/g, "").slice(0, max) || null;
  const text = (value, max) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max) || null;
  const state = text(input.state ?? input.uf, 2)?.toUpperCase() ?? null;
  if (state && !BRAZILIAN_STATES.has(state)) throw new CheckoutInputError("UF inválida.", "invalid_address");
  const postCode = digits(input.postCode ?? input.cep, 8);
  if (postCode && postCode.length !== 8) throw new CheckoutInputError("CEP inválido.", "invalid_address");
  const address = {
    postCode,
    street: text(input.street ?? input.rua, 160),
    number: text(input.number ?? input.numero, 16),
    complement: text(input.complement ?? input.complemento, 160),
    district: text(input.district ?? input.bairro, 120),
    city: text(input.city ?? input.cidade, 120),
    state,
  };
  return Object.values(address).some(Boolean) ? address : null;
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
    cpfCnpj: cleanDocument(input.documentNumber),
    birthDate: cleanBirthDate(input.birthDate ?? input.birth_date),
    address: cleanAddress(input.address),
    ip,
  };
}

function validateMinimumCharge(totalCents, payment) {
  const pixMethod = payment.method === "pix" || payment.method === "pix_installment";
  const minimumInstallmentCents = pixMethod
    ? MIN_PIX_INSTALLMENT_CENTS
    : MIN_CARD_INSTALLMENT_CENTS;
  const minimumTotalCents = minimumInstallmentCents * payment.installments;
  if (totalCents >= minimumTotalCents) return;

  if (payment.method === "pix") {
    throw new CheckoutInputError(
      "O valor mínimo para pagamento por Pix é R$ 10,00. Ajuste o cupom ou adicione outro curso.",
      "payment_amount_below_minimum",
    );
  }
  const methodLabel = payment.method === "pix_installment" ? "Pix" : "cartão";
  const minimum = (minimumInstallmentCents / 100).toFixed(2).replace(".", ",");
  throw new CheckoutInputError(
    `Cada parcela no ${methodLabel} precisa ter no mínimo R$ ${minimum}. Escolha menos parcelas ou ajuste o cupom.`,
    "payment_amount_below_minimum",
  );
}

function parsePayment(input) {
  if (!input || typeof input !== "object") throw new CheckoutInputError("Meio de pagamento inválido.");
  if (input.method === "pix") return { method: "pix", installments: 1 };
  if (!["pix_installment", "credit_card"].includes(input.method)) {
    throw new CheckoutInputError("Meio de pagamento inválido.");
  }
  const installments = Number(input.installments);
  const maximum = input.method === "pix_installment"
    ? MAX_PIX_INSTALLMENTS
    : MAX_INTEREST_FREE_INSTALLMENTS;
  if (
    !Number.isSafeInteger(installments)
    || installments < (input.method === "pix_installment" ? 2 : 1)
    || installments > maximum
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

function checkoutFingerprint(body, customerId) {
  return createHash("sha256").update(JSON.stringify({ body, customerId })).digest("hex");
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
    // endereço completo quando coletado: melhora o cadastro do pagador na Asaas
    ...(buyer.address?.street ? {
      address: buyer.address.street,
      addressNumber: buyer.address.number ?? "S/N",
      complement: buyer.address.complement ?? undefined,
      province: buyer.address.district ?? undefined,
      postalCode: buyer.address.postCode ?? undefined,
    } : {}),
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

function publicPixInstructions(pix) {
  if (typeof pix?.encodedImage !== "string" || typeof pix?.payload !== "string") return null;
  if (!pix.encodedImage.trim() || !pix.payload.trim()) return null;
  return {
    qrCodeBase64: pix.encodedImage,
    emv: pix.payload,
    expiresAt: pix.expirationDate ?? null,
  };
}

export function createCheckoutRouter(express, {
  environment,
  asaasClient,
  installmentService,
  store,
  onAccessGranted = null,
}) {
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
      cardInstallmentMaximum: MAX_INTEREST_FREE_INSTALLMENTS,
      pixInstallmentMode: "monthly_manual_payment",
      pixInstallmentMaximum: MAX_PIX_INSTALLMENTS,
      pixAutomatic: false,
      minimumPixInstallmentCents: MIN_PIX_INSTALLMENT_CENTS,
      minimumCardInstallmentCents: MIN_CARD_INSTALLMENT_CENTS,
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
    const cardInstallments = createInterestFreeInstallments(quote.totalCents);
    const pixInstallments = createInterestFreeInstallments(quote.totalCents, {
      maximum: MAX_PIX_INSTALLMENTS,
      minimumInstallmentCents: MIN_PIX_INSTALLMENT_CENTS,
    })
      .filter((option) => option.number >= 2)
      .map((option) => ({
        number: option.number,
        totalCents: option.totalCents,
        installmentCents: option.installmentCents,
        lastInstallmentCents: option.lastInstallmentCents,
        installmentAmountsCents: option.installmentAmountsCents,
      }));
    response.json({
      baseTotalCents: quote.totalCents,
      maximumInstallments: MAX_INTEREST_FREE_INSTALLMENTS,
      maximumPixInstallments: MAX_PIX_INSTALLMENTS,
      cardInterestFree: true,
      pixTotalPreserved: true,
      installments: cardInstallments,
      cardInstallments,
      pixInstallments,
    });
  });

  router.post("/orders", limiter, async (request, response) => {
    if (!requireProvider(response)) return;

    let key;
    let quote;
    let buyer;
    let payment;
    let accountSession;
    try {
      key = idempotencyKey(request);
      quote = await quoteFromBody(request.body, store);
      buyer = parseBuyer(request.body?.buyer, request.ip);
      payment = parsePayment(request.body?.payment);
      accountSession = await customerSessionFromRequest(
        request,
        store,
        environment.sessionPepper,
      );
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }
    if (!accountSession) {
      response.status(401).json({
        error: "customer_authentication_required",
        message: "Entre na sua conta antes de concluir o pagamento.",
      });
      return;
    }
    if (accountSession.customer.email !== buyer.email) {
      response.status(400).json({
        error: "customer_email_mismatch",
        message: "Use o mesmo e-mail da sua conta no checkout.",
        retryable: true,
      });
      return;
    }
    try {
      validateMinimumCharge(quote.totalCents, payment);
    } catch (error) {
      if (handleInputError(error, response)) return;
      throw error;
    }

    const fingerprint = checkoutFingerprint(request.body, accountSession.customer.id);
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
      const installment = interestFreeInstallment(quote.totalCents, payment.installments, {
        minimumInstallmentCents: payment.method === "credit_card"
          ? MIN_CARD_INSTALLMENT_CENTS
          : MIN_PIX_INSTALLMENT_CENTS,
      });
      if (payment.installments > 1 && !installment) {
        throw new CheckoutInputError("O parcelamento escolhido não está disponível.", "invalid_installments");
      }

      await store.updateCustomerProfile(accountSession.customer.id, {
        displayName: buyer.name,
        mobilePhone: buyer.mobilePhone,
        documentLast4: buyer.cpfCnpj.slice(-4),
      });
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

      const localOrder = await store.createOrder({
        provider: "asaas",
        providerOrderId: orderId,
        providerGroupId: providerPayment?.installment
          ? providerId(providerPayment.installment, "installment id")
          : null,
        checkoutAttemptKey: quote.coupon ? key : null,
        status: normalizeAsaasPaymentStatus(updatedPayment?.status ?? providerPayment?.status),
        buyerEmail: buyer.email,
        buyerCpf: buyer.cpfCnpj,
        buyerName: buyer.name,
        buyerPhone: buyer.mobilePhone,
        buyerBirthDate: buyer.birthDate,
        buyerAddress: buyer.address,
        customerId: accountSession.customer.id,
        paymentMethod: payment.method,
        installments: payment.installments,
        installmentCents: installment?.installmentCents ?? quote.totalCents,
        couponCode: quote.coupon?.code ?? null,
        subtotalCents: quote.subtotalCents,
        discountCents: quote.discountCents,
        totalCents: quote.totalCents,
        lines: quote.lines,
      });
      couponReservationBound = Boolean(quote.coupon);
      // Rede de segurança: o webhook da Asaas pode ter confirmado o pagamento
      // ANTES deste createOrder (Pix confirmando em segundos, ou cobrança criada
      // fora do fluxo). Nessa corrida a order nasceu paga e sem dados do
      // comprador, e o handler do webhook não conseguiu matricular. Agora que o
      // pedido foi enriquecido com email/CPF/nome, dispara a concessão de acesso.
      // A fila de matrícula é idempotente (dedupe por pedido+curso e cliente+curso).
      if (localOrder.status === "paid" && onAccessGranted) {
        onAccessGranted(localOrder.id).catch((error) => {
          console.error("Could not enqueue enrollment for reconciled checkout order", {
            orderId: localOrder.id,
            type: error?.name,
          });
        });
      }
      if (payment.method === "pix_installment") {
        try {
          await installmentService?.sync(localOrder);
        } catch (syncError) {
          console.error("Could not synchronize the new Asaas installment plan", {
            orderId,
            code: syncError?.code,
            type: syncError?.name,
          });
        }
      }

      if (payment.method === "pix" || payment.method === "pix_installment") {
        let pix = null;
        try {
          pix = publicPixInstructions(await asaasClient.getPixQrCode(orderId));
        } catch (pixError) {
          console.error("Asaas Pix instructions are still being prepared", {
            orderId,
            status: pixError?.status,
            code: pixError?.code,
          });
        }
        result = {
          status: 201,
          body: {
            orderId,
            status: normalizeAsaasPaymentStatus(updatedPayment?.status ?? providerPayment?.status),
            method: payment.method,
            installments: payment.installments,
            installmentCents: installment?.installmentCents ?? quote.totalCents,
            totalCents: quote.totalCents,
            ...(pix ? { pix } : { pixPending: true }),
          },
        };
      } else {
        const secureInvoiceUrl = safeAsaasInvoiceUrl(invoiceUrl);
        if (!secureInvoiceUrl) {
          throw new Error("Asaas returned no secure invoice URL.");
        }
        result = {
          status: 201,
          body: {
            orderId,
            status: normalizeAsaasPaymentStatus(updatedPayment?.status ?? providerPayment?.status),
            method: "credit_card",
            installments: payment.installments,
            totalCents: quote.totalCents,
            redirectUrl: secureInvoiceUrl,
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

  router.get("/orders/:orderId/pix", limiter, async (request, response) => {
    if (!requireProvider(response)) return;
    response.set("Cache-Control", "no-store");
    try {
      const orderId = providerId(request.params.orderId);
      const accountSession = await customerSessionFromRequest(
        request,
        store,
        environment.sessionPepper,
      );
      if (!accountSession) {
        response.status(401).json({
          error: "customer_authentication_required",
          message: "Entre na sua conta para abrir o Pix.",
        });
        return;
      }
      const localOrder = await store.getCustomerOrderByProviderOrderId(
        accountSession.customer.id,
        "asaas",
        orderId,
      );
      if (!localOrder || !["pix", "pix_installment"].includes(localOrder.paymentMethod)) {
        response.status(404).json({
          error: "order_not_found",
          message: "Não encontramos este Pix na sua conta.",
        });
        return;
      }
      const payment = await asaasClient.getPayment(orderId);
      const status = normalizeAsaasPaymentStatus(payment?.status);
      if (status === "paid") {
        response.json({ id: orderId, status });
        return;
      }
      try {
        const pix = publicPixInstructions(await asaasClient.getPixQrCode(orderId));
        if (pix) {
          response.json({ id: orderId, status, pix });
          return;
        }
      } catch (pixError) {
        if (![400, 404, 409].includes(Number(pixError?.status))) throw pixError;
      }
      response.status(202).json({ id: orderId, status, pixPending: true });
    } catch (error) {
      console.error("Asaas Pix retrieval failed", {
        endpoint: error?.endpoint,
        status: error?.status,
      });
      response.status(error?.status === 404 ? 404 : 502).json({
        error: "pix_retrieval_failed",
        message: "O Pix foi criado, mas o QR Code ainda não está disponível. Tente novamente em instantes.",
      });
    }
  });

  router.get("/orders/:orderId", limiter, async (request, response) => {
    if (!requireProvider(response)) return;
    let orderId;
    try {
      orderId = providerId(request.params.orderId);
      const payment = await asaasClient.getPayment(orderId);
      response.json({ id: providerId(payment?.id ?? orderId), status: normalizeAsaasPaymentStatus(payment?.status) });
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
