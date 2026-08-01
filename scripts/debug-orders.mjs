#!/usr/bin/env node
/**
 * debug-orders.mjs — Sonda findStudent + findOrdersByStudent ao vivo para
 * entender por que o flip não acha a order da tag.
 */
import { createArtClient } from "../src/integrations/art/client.js";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const idmOrigin = process.env.ART_IDM_BASE ?? "https://ms-idm.academiarafaeltoro.com.br";
const email = process.env.ART_TEST_EMAIL ?? "kocaxa6628@bejum.com";
const cpf = process.env.ART_TEST_CPF ?? "59399841006";

const client = createArtClient({ apiOrigin, idmOrigin, requestTimeoutMs: 30_000 });
const xApiKey = generateXApiKey();
const line = (s) => console.log(s);

try {
  const session = await client.login(email, cpf);
  line(`login OK user_id=${session.userId}`);
  line(`raw keys: ${Object.keys(session.raw).join(", ")}`);
  line(`raw.id_usuario=${session.raw?.id_usuario} raw.id=${session.raw?.id} raw.profile_id=${session.raw?.profile_id}`);
  const token = session.token;

  // findStudent — qual id_usuario vem no perfil?
  const found = await client.findStudent({ email, xApiKey, token });
  line(`\nfindStudent HTTP ${found.status}`);
  line(`findStudent body: ${JSON.stringify(found.body).slice(0, 500)}`);

  const idUsuarioCandidates = [
    found.body?.id_usuario,
    session.raw?.id_usuario,
    session.raw?.id,
    session.raw?.profile_id,
    session.raw?.userId,
  ].filter((v) => v !== undefined && v !== null);

  line(`\ncandidatos id_usuario: ${idUsuarioCandidates.join(", ")}`);

  for (const idUsuario of idUsuarioCandidates) {
    const ord = await client.findOrdersByStudent({ idUsuario, xApiKey, token });
    line(`\nfindOrdersByStudent(id_usuario=${idUsuario}) HTTP ${ord.status}`);
    line(`body: ${JSON.stringify(ord.body).slice(0, 800)}`);
  }
} catch (error) {
  line(`ERRO: ${error.message}`);
  line(`stack: ${error.stack?.slice(0, 400)}`);
}
