#!/usr/bin/env node
/** probe-prepare.mjs — mostra a turma vigente real de cada source_tag ativo (via prepare). */
import mysql from "mysql2/promise";
import { createArtClient } from "../src/integrations/art/client.js";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const client = createArtClient({ apiOrigin: "https://api.academiarafaeltoro.com.br", idmOrigin: "https://api.academiarafaeltoro.com.br", requestTimeoutMs: 25_000 });
const xApiKey = generateXApiKey();
const url = new URL(process.env.MYSQL_URL);
const conn = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
});

const [rows] = await conn.query("SELECT slug, source_tag, cohort, title FROM products WHERE active = 1");
for (const p of rows) {
  if (!p.source_tag) continue;
  let real = null;
  try {
    const { status, body } = await client.prepareCheckout({ tag: p.source_tag, idTurma: "", xApiKey });
    if (status === 200 && body?.course?.id_turma) real = Number(body.course.id_turma);
  } catch {}
  console.log(`${String(p.slug).padEnd(34)} cohort_bd=${String(p.cohort).padEnd(6)} turma_vigente=${String(real).padEnd(6)} ${real === Number(p.cohort) ? "OK" : (real ? "-> ATUALIZAR" : "sem resposta")}`);
}
await conn.end();
