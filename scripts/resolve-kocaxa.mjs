#!/usr/bin/env node
/**
 * resolve-kocaxa.mjs — Descobre o CPF real da conta kocaxa na ART usando o
 * token da conta logs (findStudent). Depois testa o login com o CPF real.
 */
import { createArtClient } from "../src/integrations/art/client.js";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const idmOrigin = process.env.ART_IDM_BASE ?? "https://ms-idm.academiarafaeltoro.com.br";

const client = createArtClient({ apiOrigin, idmOrigin, requestTimeoutMs: 30_000 });
const xApiKey = generateXApiKey();
const line = (s) => console.log(s);

// 1. login com a conta logs (que conhecemos)
const logsEmail = "logs@cyara.com.br";
const logsCpf = "40469403284";
const logsSession = await client.login(logsEmail, logsCpf);
line(`login logs OK user_id=${logsSession.userId}`);

// 2. findStudent para kocaxa usando o token do logs
const target = process.env.ART_TEST_EMAIL ?? "kocaxa6628@bejum.com";
const found = await client.findStudent({ email: target, xApiKey, token: logsSession.token });
line(`findStudent(${target}) HTTP ${found.status}`);
line(`body: ${JSON.stringify(found.body).slice(0, 600)}`);

if (found.status === 200 && found.body?.documento) {
  const doc = String(found.body.documento).replace(/\D/g, "");
  line(`\nCPF real da conta ${target}: ${doc}`);
  // 3. tenta login com o CPF real
  try {
    const sess = await client.login(target, doc);
    line(`login ${target} com CPF ${doc} -> OK user_id=${sess.userId}`);
  } catch (error) {
    line(`login ${target} com CPF ${doc} -> FALHOU: ${error.message}`);
  }
} else {
  line(`\n${target} SEM conta na ART (findStudent ${found.status}) — pode provisionar conta nova sem divergencia`);
}
