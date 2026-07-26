const TOKEN_REFRESH_SKEW_MS = 60_000;

export class AppmaxApiError extends Error {
  constructor(message, { status = 502, endpoint = "unknown" } = {}) {
    super(message);
    this.name = "AppmaxApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return response.json().catch(() => null);
}

export function createAppmaxClient(environment, fetchImplementation = fetch) {
  if (!environment.appmaxAvailable) return null;

  let tokenCache = null;

  async function getToken(forceRefresh = false) {
    if (!forceRefresh && tokenCache && tokenCache.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return tokenCache.value;
    }

    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: environment.appmaxMerchantClientId,
      client_secret: environment.appmaxMerchantClientSecret,
    });
    const response = await fetchImplementation(`${environment.appmaxAuthOrigin}/oauth2/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const result = await parseResponse(response);
    if (!response.ok || typeof result?.access_token !== "string") {
      throw new AppmaxApiError("Appmax authentication failed.", {
        status: response.status || 502,
        endpoint: "/oauth2/token",
      });
    }

    tokenCache = {
      value: result.access_token,
      expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000,
    };
    return tokenCache.value;
  }

  async function request(pathname, { method = "GET", body, retry = true } = {}) {
    const token = await getToken();
    const response = await fetchImplementation(`${environment.appmaxApiOrigin}${pathname}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await parseResponse(response);

    if (response.status === 401 && retry) {
      await getToken(true);
      return request(pathname, { method, body, retry: false });
    }
    if (!response.ok) {
      throw new AppmaxApiError("Appmax request failed.", {
        status: response.status || 502,
        endpoint: pathname,
      });
    }
    return result;
  }

  return Object.freeze({
    createCustomer: (payload) => request("/v1/customers", { method: "POST", body: payload }),
    createOrder: (payload) => request("/v1/orders", { method: "POST", body: payload }),
    createPixPayment: (payload) => request("/v1/payments/pix", { method: "POST", body: payload }),
    createCardPayment: (payload) => request("/v1/payments/credit-card", { method: "POST", body: payload }),
    getInstallments: (payload) => request("/v1/payments/installments", { method: "POST", body: payload }),
    getOrder: (orderId) => request(`/v1/orders/${encodeURIComponent(orderId)}`),
  });
}
