import { publicEncrypt, constants } from "node:crypto";

// Chave pública da plataforma ART usada para selar o x-api-key de checkout e para
// cifrar o cartão do payload (a plataforma decripta com a chave privada dela).
// É a chave fixa do fluxo real validado — não é segredo do operador.
const PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5+/4ltzmA6H7CaBsmaixUiFLq
5kr3ZqreOd80IECMXiFJ46TSf/T17MU3n40ZGIlS54UbkST0e6JEApKVgMh7tFjq
5aU78nKEKKx76oNUWrkHarh551Vpvc46O1MasP32PiucWXs8FqaEK3aZQc+pxOyD
qhbzzkjPjKAAKs6hDwIDAQAB
-----END PUBLIC KEY-----`;

function rsaEncryptBase64(plaintext) {
  return publicEncrypt(
    { key: PUB_PEM, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  ).toString("base64");
}

// x-api-key de checkout: RSA_PKCS1v15("@newCheckout") com a chave pública acima.
// O plaintext e a chave são fixos no fluxo real da plataforma.
export function generateXApiKey() {
  return rsaEncryptBase64("@newCheckout");
}

// Cifra o cartão exatamente como a SPA de checkout da ART: JSON do cartão
// (card_number/holder_document só com dígitos), dividido em blocos de 100 chars,
// cada bloco RSA_PKCS1v15, resultado = string JSON de um array de base64.
// Enviar o cartão cifrado (mesmo vazio) faz parte do payload FIEL que a
// plataforma aceita — payloads com card:"" quebram antes de provisionar.
export function encryptCard(card) {
  const clean = { ...card };
  clean.card_number = String(card?.card_number ?? "").replace(/[-_. ]/g, "");
  clean.holder_document = String(card?.holder_document ?? "").replace(/[-_. ]/g, "");
  const json = JSON.stringify(clean);
  const chunks = json.match(/.{1,100}/g) ?? [];
  return JSON.stringify(chunks.map((chunk) => rsaEncryptBase64(chunk)));
}

// Monta os headers das chamadas ART. O token é OPCIONAL: o provisionamento
// (fase 1) e o prepare rodam só com x-api-key, sem Bearer — desde que o payload
// seja fiel à SPA, a conta é provisionada sem nenhum token de usuário.
export function headersFor(xApiKey, token, json = false) {
  const headers = {
    "x-api-key": xApiKey,
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}
