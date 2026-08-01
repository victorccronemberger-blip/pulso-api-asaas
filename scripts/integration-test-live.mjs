#!/usr/bin/env node
/**
 * integration-test-live.mjs — Teste de integração REAL do motor de matrícula
 * (src/integrations/art) contra a plataforma ART ao vivo.
 *
 * Prova o fluxo completo do backend (não o PoC Python):
 *   login RS256 real -> resolução de turma -> fase 2 -> polling -> flip (VETOR C)
 *   -> swap de turma (VETOR D) -> turma de combo (VETOR E)
 *
 * Uso:
 *   ART_TEST_EMAIL=logs@cyara.com.br ART_TEST_CPF=40469403284 \
 *   ART_TEST_TAG=matematica-financeira_2026 \
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/integration-test-live.mjs
 *
 * Env opcionais:
 *   ART_API_BASE / ART_IDM_BASE  (origens da plataforma; defaults produção)
 *   ART_TEST_TURMAS="4124,4091"  (candidatos explícitos; default: cohort do catálogo)
 */
import { createArtClient } from "../src/integrations/art/client.js";
import { createEnrollmentService } from "../src/integrations/art/enrollment.js";

const apiOrigin = process.env.ART_API_BASE ?? "https://api.academiarafaeltoro.com.br";
const idmOrigin = process.env.ART_IDM_BASE ?? "https://ms-idm.academiarafaeltoro.com.br";
const email = process.env.ART_TEST_EMAIL ?? "logs@cyara.com.br";
const cpf = process.env.ART_TEST_CPF ?? "40469403284";
const tag = process.env.ART_TEST_TAG ?? "matematica-financeira_2026";
const candidateTurmas = (process.env.ART_TEST_TURMAS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const comboTurmas = (process.env.ART_COMBO_TURMAS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean).map(Number);

const client = createArtClient({
  apiOrigin,
  idmOrigin,
  requestTimeoutMs: 30_000,
  pollTimeoutMs: Number(process.env.ART_POLL_TIMEOUT_MS ?? 30_000), // curto: flip entra rapido
  pollIntervalMs: 6_000,
});

const service = createEnrollmentService(client, {
  provisionTimeoutMs: 60_000,
  serviceAccounts: [], // sem service account: fluxo usa cohort + scan adaptativo
});

const line = (s) => console.log(`LOG: ${s}`);

line(`inicio: email=${email} tag=${tag} candidatos=${candidateTurmas.length ? candidateTurmas.join(",") : "(cohort)"}`);

// 0. sanity: login + lista cursos atuais do aluno (para comparar depois)
try {
  const before = await service.listStudentCourses({ email, cpf });
  const tags = before.map((c) => c.tag);
  line(`estado antes: ${before.length} curso(s): ${tags.join(", ")}`);
  line(`tag ${tag} ja ativa antes? ${tags.includes(tag) || tags.includes(tag.toUpperCase())}`);
} catch (error) {
  line(`sanity list falhou (segue mesmo assim): ${String(error).slice(0, 200)}`);
}

// 1. ativação real
const result = await service.enrollStudent({
  email,
  cpf,
  tag,
  fullName: "Poc Toro",
  candidateTurmas: candidateTurmas.length ? candidateTurmas : null,
  comboTurmas: comboTurmas.length ? comboTurmas : null,
  onLog: line,
});

line("=== RESULTADO ===");
line(JSON.stringify(result, null, 2));

// 2. confirmação no lado ART
try {
  const after = await service.listStudentCourses({ email, cpf });
  const tags = after.map((c) => c.tag);
  line(`estado depois: ${after.length} curso(s): ${tags.join(", ")}`);
  const hit = after.find((c) => c.tag === tag || c.tag === tag.toUpperCase());
  line(hit ? `>>> CONFIRMADO no findCourses: ${JSON.stringify({ tag: hit.tag, id_order: hit.id_order, id_turma: hit.id_turma, is_visible: hit.is_visible })}` : ">>> curso ainda nao listado no findCourses");
} catch (error) {
  line(`verificacao final falhou: ${String(error).slice(0, 200)}`);
}

process.exit(result.status === "CONFIRMED" ? 0 : 2);
