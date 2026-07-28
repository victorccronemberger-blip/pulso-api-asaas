import {
  parseCookies,
  safeEqual,
  serializeCookie,
  tokenHash,
} from "../admin/security.js";

export const CUSTOMER_SESSION_COOKIE = "__Host-pulso_customer";
export const CUSTOMER_CSRF_COOKIE = "pulso_customer_csrf";

export function setCustomerCookies(response, sessionToken, csrfToken, ttlSeconds) {
  response.append(
    "Set-Cookie",
    serializeCookie(CUSTOMER_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      maxAge: ttlSeconds,
    }),
  );
  response.append(
    "Set-Cookie",
    serializeCookie(CUSTOMER_CSRF_COOKIE, csrfToken, {
      maxAge: ttlSeconds,
    }),
  );
}

export function clearCustomerCookies(response) {
  response.append(
    "Set-Cookie",
    serializeCookie(CUSTOMER_SESSION_COOKIE, "", { httpOnly: true, maxAge: 0 }),
  );
  response.append(
    "Set-Cookie",
    serializeCookie(CUSTOMER_CSRF_COOKIE, "", { maxAge: 0 }),
  );
}

export async function customerSessionFromRequest(request, store, pepper) {
  const cookies = parseCookies(request.get("cookie"));
  const token = cookies[CUSTOMER_SESSION_COOKIE];
  if (!token) return null;
  return store.getCustomerSession(tokenHash(token, pepper));
}

export function validCustomerCsrf(request, session, pepper) {
  const cookies = parseCookies(request.get("cookie"));
  const cookieToken = cookies[CUSTOMER_CSRF_COOKIE];
  const headerToken = request.get("X-CSRF-Token");
  return Boolean(
    cookieToken
    && headerToken
    && safeEqual(cookieToken, headerToken)
    && safeEqual(tokenHash(headerToken, pepper), session.csrfHash),
  );
}
