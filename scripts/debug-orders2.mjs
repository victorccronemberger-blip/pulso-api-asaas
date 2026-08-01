#!/usr/bin/env node
/**
 * debug-orders2.mjs — Sonda login + findStudent + findOrdersByStudent com a
 * conta NOVA (geripar303) para descobrir qual id_usuario o flip deve usar.
 */
import { createArtClient } from "../src/integrations/art/client.js";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const idmOrigin = process.env.ART_IDM_BASE ?? "https://ms-idm.academiarafaeltoro.com.br";
const email = process.env.ART_TEST_EMAIL ?? "geripar303@bora4d.com";
const cpf = process.env.ART_TEST_CPF ?? "53756768775";

const client = createArtClient({ apiOrigin, idmOrigin, requestTimeoutMs: 30_000 });
const xApiKey = generateXApiKey();
const line = (s) => console.log(s);

const session = await client.login(email, cpf);
line(`login OK user_id=${session.userId}`);
line(`raw: ${JSON.stringify(session.raw).slice(0, 600)}`);

const found = await client.findStudent({ email, xApiKey, token: session.token });
line(`\nfindStudent HTTP ${found.status}`);
line(`body: ${JSON.stringify(found.body).slice(0, 600)}`);

const candidates = [
  ["found.body.id_usuario", found.body?.id_usuario],
  ["found.body.id", found.body?.id],
  ["session.raw.id", session.raw?.id],
  ["session.raw.profile_id", session.raw?.profile_id],
  ["session.raw.user_id", session.raw?.user_id],
  ["session.raw.id_usuario", session.raw?.id_usuario],
].filter(([k, v]) => v !== undefined && v !== null);

line(`\ncandidatos id_usuario: ${candidates.map(([k, v]) => `${k}=${v}`).join(" | ")}`);

for (const [label, idUsuario] of candidates) {
  const ord = await client.findOrdersByStudent({ idUsuario, xApiKey, token: session.token });
  line(`\nfindOrdersByStudent(${label}=${idUsuario}) HTTP ${ord.status}`);
  line(`body: ${JSON.stringify(ord.body).slice(0, 700)}`);
}
