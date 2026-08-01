#!/usr/bin/env node
/**
 * debug-cfa.mjs — Debug ao vivo: acha a order cfa_2025 da conta geripar.
 * 1) findOrdersByStudent (profile_id)
 * 2) scan GET /v1/crud/orders/{id} no range (como a pesquisa Python)
 */
import { createArtClient } from "../src/integrations/art/client.js";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const idmOrigin = process.env.ART_IDM_BASE ?? "https://ms-idm.academiarafaeltoro.com.br";
const email = process.env.ART_TEST_EMAIL ?? "geripar303@bora4d.com";
const cpf = process.env.ART_TEST_CPF ?? "53756768775";

const client = createArtClient({ apiOrigin, idmOrigin, requestTimeoutMs: 25_000 });
const xApiKey = generateXApiKey();
const line = (s) => console.log(s);

const session = await client.login(email, cpf);
line(`login OK user_id=${session.userId} raw.id=${session.raw?.id} raw.profile_id=${session.raw?.profile_id}`);
const token = session.token;

const found = await client.findStudent({ email, xApiKey, token });
line(`findStudent HTTP ${found.status}: ${JSON.stringify(found.body).slice(0, 300)}`);
const profileId = found.body?.id_usuario ?? session.raw?.profile_id ?? session.raw?.id;
line(`profileId usado: ${profileId}`);

// 1) findOrdersByStudent
const ord = await client.findOrdersByStudent({ idUsuario: profileId, xApiKey, token });
line(`\nfindOrdersByStudent(${profileId}) HTTP ${ord.status}`);
line(`body: ${JSON.stringify(ord.body).slice(0, 1500)}`);

// 2) scan de orders da conta via GET /v1/crud/orders/{id}
line("\nscan GET /v1/crud/orders/{id} no range 3129400..3129600");
const mine = [];
for (let oid = 3129400; oid <= 3129600; oid += 1) {
  try {
    const r = await client.getOrder({ idOrder: oid, xApiKey, token });
    if (r.status === 200 && r.body && typeof r.body === "object" && r.body.id_order && String(r.body.id_usuario) === String(profileId)) {
      mine.push({ oid, curso: r.body.curso, status: r.body.status, id_turma: r.body.id_turma, id_curso: r.body.id_curso, json: String(r.body.json_retorno).slice(0, 80) });
    }
  } catch { /* 404/erro — segue */ }
}
line(`orders da conta no range: ${mine.length}`);
for (const m of mine) line(`  ${m.oid}: ${m.curso} status=${m.status} turma=${m.id_turma} id_curso=${m.id_curso}`);
