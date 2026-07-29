// Diagnóstico de saúde dos cohorts (id_turma) dos produtos frente à plataforma ART.
// Para cada produto ativo: verifica se o cohort gravado está vivo (prepare 200) e,
// se morto/nulo, descobre a turma viva varrendo ids próximos. Mostra onde a
// liberação (manual ou automática) pode quebrar por turma dinâmica.
// Uso: MYSQL_URL='mysql://...' node scripts/check-art-cohorts.mjs
import { Agent } from "undici";
import mysql from "mysql2/promise";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const databaseUrl = process.env.MYSQL_URL;
if (!databaseUrl) throw new Error("MYSQL_URL is required.");
const API = "https://api.academiarafaeltoro.com.br";
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const fetchArt = (url, options = {}) => fetch(url, { ...options, dispatcher });
const xApiKey = generateXApiKey();

async function prepare(tag, idTurma) {
  try {
    const url = `${API}/v1/checkout/prepare?tag=${encodeURIComponent(tag)}&id_turma=${idTurma}`;
    const res = await fetchArt(url, { headers: { "x-api-key": xApiKey, Accept: "application/json" } });
    if (res.status === 200) {
      const body = await res.json();
      if (body?.course) return { alive: true, course: body.course };
    }
    return { alive: false };
  } catch {
    return { alive: false };
  }
}

async function scanLive(tag, center) {
  const idSet = new Set();
  for (let id = Math.max(1, center - 100); id <= center + 700; id++) idSet.add(id);
  for (let id = 3950; id <= 4450; id++) idSet.add(id); // faixa recente: pega saltos p/ frente
  const ids = [...idSet];
  const live = [];
  const concurrency = 24;
  for (let s = 0; s < ids.length; s += concurrency) {
    const batch = ids.slice(s, s + concurrency);
    const results = await Promise.all(batch.map(async (id) => {
      const r = await prepare(tag, id);
      return r.alive ? { id, course: r.course } : null;
    }));
    for (const r of results) if (r) live.push(r);
  }
  return live.sort((a, b) => b.id - a.id);
}

const pool = mysql.createPool({ uri: databaseUrl, timezone: "Z" });
const [products] = await pool.query("SELECT slug, source_tag AS sourceTag, cohort, title FROM products WHERE active=1 ORDER BY sort_order");
await pool.end();

console.log(`Verificando ${products.length} produtos ativos na ART...\n`);
const stale = [];
for (const p of products) {
  const cohort = p.cohort ? Number(p.cohort) : null;
  if (!cohort) {
    console.log(`?? ${p.slug.padEnd(36)} ${p.sourceTag.padEnd(28)} cohort=NULL -> precisa descoberta`);
    stale.push({ slug: p.slug, sourceTag: p.sourceTag, cohort: null, liveIds: [], newest: null });
    continue;
  }
  const r = await prepare(p.sourceTag, cohort);
  if (r.alive) {
    console.log(`OK ${p.slug.padEnd(36)} ${p.sourceTag.padEnd(28)} cohort=${String(cohort).padEnd(5)} VIVO (valor=${r.course.valor_curso ?? "?"})`);
  } else {
    process.stdout.write(`XX ${p.slug.padEnd(36)} ${p.sourceTag.padEnd(28)} cohort=${String(cohort).padEnd(5)} MORTO -> descobrindo...`);
    const live = await scanLive(p.sourceTag, cohort);
    if (live.length) {
      console.log(`\n   -> vivas: ${live.map((l) => l.id).join(", ")} (mais recente ${live[0].id}, dist=+${live[0].id - cohort})`);
      stale.push({ slug: p.slug, sourceTag: p.sourceTag, cohort, liveIds: live.map((l) => l.id), newest: live[0].id });
    } else {
      console.log(`\n   -> NENHUMA turma viva no range (tag errada? curso desativado?)`);
      stale.push({ slug: p.slug, sourceTag: p.sourceTag, cohort, liveIds: [], newest: null });
    }
  }
}
console.log(`\n=== Resumo: ${stale.length} produto(s) com cohort morto/nulo de ${products.length} ===`);
if (stale.length) console.log(JSON.stringify(stale, null, 2));
