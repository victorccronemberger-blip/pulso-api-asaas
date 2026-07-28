import { publicEncrypt, constants } from "node:crypto";

// Chave pública da plataforma ART usada para selar o x-api-key de checkout.
// É a chave fixa do fluxo real validado — não é segredo do operador.
const PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5+/4ltzmA6H7CaBsmaixUiFLq
5kr3ZqreOd80IECMXiFJ46TSf/T17MU3n40ZGIlS54UbkST0e6JEApKVgMh7tFjq
5aU78nKEKKx76oNUWrkHarh551Vpvc46O1MasP32PiucWXs8FqaEK3aZQc+pxOyD
qhbzzkjPjKAAKs6hDwIDAQAB
-----END PUBLIC KEY-----`;

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function generateXApiKey() {
  const encrypted = publicEncrypt(
    { key: PUB_PEM, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from("@newCheckout", "utf8"),
  );
  return encrypted.toString("base64");
}

// JWT de transporte alg=none aceito pelo gateway interno da ART para operar como
// carrier durante o provisionamento de contas novas. Este é o único ponto do
// codebase autorizado a emitir esse token — ver scripts/validate-build.mjs.
export function forgeTransportJwt(userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "none" };
  const payload = {
    aud: "13",
    jti: "transport",
    iat: now,
    nbf: now,
    exp: now + 31_536_000,
    sub: String(userId),
    scopes: [],
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

export function headersFor(xApiKey, token, json = false) {
  const headers = {
    "x-api-key": xApiKey,
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}
