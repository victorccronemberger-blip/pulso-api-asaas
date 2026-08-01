#!/usr/bin/env node
/**
 * auto-retry-live.mjs — Testa o login a cada ~120s; no momento em que o
 * ms-idm desbloquear o IP, roda a ativação real (ancord-2026) e salva o
 * resultado em resultado-integracao.json. Sai com exit 0 quando ativa.
 *
 * Uso:
 *   ART_TEST_EMAIL=geripar303@bora4d.com ART_TEST_CPF=53756768775 \
 *   ART_TEST_TAG=ancord-2026 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   node scripts/auto-retry-live.mjs
 */
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createArtClient } from "../src/integrations/art/client.js";
import { createEnrollmentService } from "../src/integrations/art/enrollment.js";
import { generateXApiKey } from "../src/integrations/art/credentials.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const idmOrigin = process.env.ART_IDM_BASE ?? "https://ms-idm.academiarafaeltoro.com.br";
const email = process.env.ART_TEST_EMAIL ?? "geripar303@bora4d.com";
const cpf = process.env.ART_TEST_CPF ?? "53756768775";
const tag = process.env.ART_TEST_TAG ?? "ancord-2026";
const comboTurmas = (process.env.ART_COMBO_TURMAS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const outFile = process.env.ART_RESULT_FILE ?? "resultado-integracao.json";

const client = createArtClient({ apiOrigin, idmOrigin, requestTimeoutMs: 25_000, pollTimeoutMs: 20_000, pollIntervalMs: 5_000 });
const service = createEnrollmentService(client, { provisionTimeoutMs: 45_000, serviceAccounts: [] });
const line = (s) => console.log(`${new Date().toISOString()} ${s}`);

const tryLogin = async () => {
  try {
    const session = await client.login(email, cpf);
    return session;
  } catch {
    return null;
  }
};

let attempts = 0;
for (;;) {
  attempts += 1;
  const session = await tryLogin();
  if (session) {
    line(`login OK user_id=${session.userId} apos ${attempts} tentativas — rodando ativacao`);
    break;
  }
  line(`login bloqueado (tentativa ${attempts}) — aguardando 120s`);
  await sleep(120_000);
}

const result = await service.enrollStudent({
  email, cpf, tag, fullName: "Poc Toro", candidateTurmas: null,
  comboTurmas: comboTurmas.length ? comboTurmas : null,
  onLog: line,
});
line("=== RESULTADO ===");
line(JSON.stringify(result, null, 2));
await writeFile(outFile, JSON.stringify({ email, cpf, tag, ts: new Date().toISOString(), result }, null, 2), "utf8");
line(`salvo em ${outFile}`);

try {
  const after = await service.listStudentCourses({ email, cpf });
  const hit = after.find((c) => c.tag === tag || c.tag === tag.toUpperCase());
  line(hit ? `>>> CONFIRMADO: ${JSON.stringify({ tag: hit.tag, id_order: hit.id_order, id_turma: hit.id_turma, is_visible: hit.is_visible })}` : ">>> ainda nao listado");
} catch (e) {
  line(`verificacao final: ${String(e).slice(0, 120)}`);
}
process.exit(result.status === "CONFIRMED" ? 0 : 3);
