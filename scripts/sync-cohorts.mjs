#!/usr/bin/env node
/**
 * sync-cohorts.mjs — Sincroniza a coluna `cohort` da tabela `products` com a
 * TURMA VIGENTE REAL devolvida pelo checkout da ART (GET /v1/checkout/prepare).
 *
 * POR QUE: o motor novo não confia no cohort (descobre a turma ao vivo), mas o
 * cohort gravado serve de âncora para o scan adaptativo. Vários estão defasados
 * (ancord 3391 -> real 4112). Atualizar deixa o scan mais rápido.
 *
 * SÓ ALTERA `cohort`. NÃO toca em title/source_tag/preço/active — os anúncios
 * do catálogo puxam os nomes, e esses ficam intactos.
 *
 * Uso:
 *   MYSQL_URL='mysql://user:pass@host:3306/db' node scripts/sync-cohorts.mjs
 */
import mysql from "mysql2/promise";
import { createArtClient } from "../src/integrations/art/client.js";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const client = createArtClient({ apiOrigin, idmOrigin: apiOrigin, requestTimeoutMs: 25_000 });
const xApiKey = generateXApiKey();

const url = new URL(process.env.MYSQL_URL);
const pool = mysql.createPool({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
  waitForConnections: true,
  connectionLimit: 3,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// Retry em cima do pool: se a conexão cair (idle timeout durante chamadas HTTP
// longas), o pool reconecta e a query é re-executada.
async function q(sql, params) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const [rows] = await pool.query(sql, params);
      return rows;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

try {
  const rows = await q("SELECT slug, source_tag, cohort, title FROM products WHERE active = 1");
  console.log(`produtos ativos: ${rows.length}\n`);

  let updated = 0;
  let skipped = 0;
  for (const p of rows) {
    const tag = p.source_tag;
    if (!tag) { skipped += 1; continue; }

    let real = null;
    // Tenta o prepare com a turma vigente (sem id_turma = devolve a vigente)
    try {
      const { status, body } = await client.prepareCheckout({ tag, idTurma: "", xApiKey });
      if (status === 200 && body?.course?.id_turma) {
        real = Number(body.course.id_turma);
      }
    } catch { /* segue */ }

    // Se o prepare sem turma falhou, tenta com o cohort atual como hint
    if (!real && p.cohort) {
      try {
        const { status, body } = await client.prepareCheckout({ tag, idTurma: String(p.cohort), xApiKey });
        if (status === 200 && body?.course?.id_turma) {
          real = Number(body.course.id_turma);
        }
      } catch { /* segue */ }
    }

    const current = p.cohort ? Number(p.cohort) : null;
    if (real && real !== current) {
      await q("UPDATE products SET cohort = ? WHERE slug = ?", [String(real), p.slug]);
      console.log(`UPDATE ${String(p.slug).padEnd(34)} cohort ${current ?? "NULL"} -> ${real}  (${tag})`);
      updated += 1;
    } else if (real && real === current) {
      console.log(`OK     ${String(p.slug).padEnd(34)} cohort ${current} ja atual (${tag})`);
    } else {
      console.log(`SKIP   ${String(p.slug).padEnd(34)} cohort ${current ?? "NULL"} — prepare nao respondeu (${tag})`);
      skipped += 1;
    }
  }

  console.log(`\nRESULTADO: ${updated} atualizados, ${rows.length - updated - skipped} ja ok, ${skipped} sem resposta`);

  // Confirma que os títulos não foram alterados
  const after = await q("SELECT slug, title FROM products WHERE active = 1");
  console.log("\nconfirma títulos intactos (amostra):");
  for (const r of after.slice(0, 6)) console.log(`  ${String(r.slug).padEnd(34)} title=${r.title}`);
} finally {
  await pool.end();
}
