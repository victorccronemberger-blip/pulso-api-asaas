#!/usr/bin/env node
/**
 * battery-live.mjs — Bateria de provas REAIS do motor reescrito.
 *
 * Quando o ms-idm liberar o IP, ativa em sequência os cursos que provam os
 * vetores ainda não exercitados ao vivo:
 *   - cfp-2026_54  (CFP 60 dias — job NEGA → precisa do FLIP, VETOR C)
 *   - cfg_2026      (CFG — job NEGA → FLIP, VETOR C)
 * Depois verifica o findCourses (app) e lista o estado da caixa de email
 * (Hostinger API) para conferir o onboarding/welcome.
 *
 * Sequencial e com pausa: um login por vez (rotação de token da ART).
 *
 * Uso:
 *   ART_TEST_EMAIL=geripar303@bora4d.com ART_TEST_CPF=53756768775 \
 *   ART_COMBO_TURMAS=4134 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   node scripts/battery-live.mjs
 */
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createArtClient } from "../src/integrations/art/client.js";
import { createEnrollmentService } from "../src/integrations/art/enrollment.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const idmOrigin = process.env.ART_IDM_BASE ?? "https://ms-idm.academiarafaeltoro.com.br";
const email = process.env.ART_TEST_EMAIL ?? "geripar303@bora4d.com";
const cpf = process.env.ART_TEST_CPF ?? "53756768775";
const comboTurmas = (process.env.ART_COMBO_TURMAS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const outFile = process.env.ART_RESULT_FILE ?? "bateria-integracao.json";

const client = createArtClient({ apiOrigin, idmOrigin, requestTimeoutMs: 25_000, pollTimeoutMs: 20_000, pollIntervalMs: 5_000 });
const service = createEnrollmentService(client, { provisionTimeoutMs: 45_000, serviceAccounts: [] });
const line = (s) => console.log(`${new Date().toISOString()} ${s}`);

const tryLogin = async () => {
  try { return await client.login(email, cpf); } catch { return null; }
};

// 1. espera o ms-idm liberar
let session = null;
for (let attempt = 1; attempt <= 50 && !session; attempt += 1) {
  session = await tryLogin();
  if (session) { line(`login OK user_id=${session.userId} (tentativa ${attempt})`); break; }
  line(`login bloqueado (tentativa ${attempt}) — aguardando 90s`);
  await sleep(90_000);
}
if (!session) { line("FALHA: login nunca liberou em 50 tentativas"); process.exit(1); }

// 2. ativa os cursos em sequência (um login por vez)
const resultados = [];
for (const tag of ["cfp-2026_54", "cfg_2026"]) {
  line(`\n=== ATIVANDO ${tag} ===`);
  try {
    const r = await service.enrollStudent({ email, cpf, tag, fullName: "Poc Toro", candidateTurmas: null, comboTurmas, onLog: line });
    line(`RESULTADO ${tag}: ${JSON.stringify({ status: r.status, idTurma: r.idTurma, strategy: r.strategy, flipRecovery: r.flipRecovery, flipApplied: r.flipApplied, order: r.enrollment?.id_order, visible: r.enrollment?.is_visible })}`);
    resultados.push({ tag, ...r });
  } catch (error) {
    line(`ERRO ${tag}: ${String(error).slice(0, 200)}`);
    resultados.push({ tag, error: String(error).slice(0, 200) });
  }
  await sleep(3000);
}

// 3. verificação final no app
try {
  const courses = await service.listStudentCourses({ email, cpf });
  line(`\n=== findCourses (${courses.length} cursos) ===`);
  for (const c of courses) line(`  - ${c.tag} | ${c.curso} | visible=${c.is_visible}`);
} catch (e) {
  line(`verificacao final: ${String(e).slice(0, 120)}`);
}

await writeFile(outFile, JSON.stringify({ email, cpf, ts: new Date().toISOString(), resultados }, null, 2), "utf8");
line(`\nsalvo em ${outFile}`);
process.exit(0);
