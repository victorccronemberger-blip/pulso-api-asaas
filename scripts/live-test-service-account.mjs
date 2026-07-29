// Prova ponta a ponta da OPÇÃO 2: motor com service account descobre a turma
// MAIS RECENTE (autoritativo, via /v1/services/turmas) e matricula, IGNORANDO o
// cohort stale passado como hint. Confirma que a matrícula não depende do cohort.
import { Agent } from "undici";
import { createArtClient } from "../src/integrations/art/client.js";
import { createEnrollmentService } from "../src/integrations/art/enrollment.js";

const SVC_EMAIL = "svc.turmas.pulso.40387859@gmail.com";
const SVC_CPF = "05938277752";

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const fetchImpl = (url, o = {}) => fetch(url, { ...o, dispatcher });

function genCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  let c1 = d.reduce((s, v, i) => s + (10 - i) * v, 0) % 11; c1 = c1 < 2 ? 0 : 11 - c1;
  const d2 = [...d, c1];
  let c2 = d2.reduce((s, v, i) => s + (11 - i) * v, 0) % 11; c2 = c2 < 2 ? 0 : 11 - c2;
  return [...d, c1, c2].join("");
}

const studentEmail = `aluno.prova.sa.${Date.now().toString().slice(-6)}@gmail.com`;
const studentCpf = genCpf();

console.log("=".repeat(70));
console.log("PROVA OPÇÃO 2 — service account sobrepõe cohort stale");
console.log(`aluno=${studentEmail} cpf=${studentCpf}`);
console.log("tag=cpa2026  cohort hint (STALE de propósito)=[3399]");
console.log("esperado: motor descobre a turma MAIS RECENTE ao vivo (não 3399)");
console.log("=".repeat(70));

const client = createArtClient({
  apiOrigin: "https://api.academiarafaeltoro.com.br",
  idmOrigin: "https://ms-idm.academiarafaeltoro.com.br",
  requestTimeoutMs: 35_000,
  pollTimeoutMs: 60_000,
  pollIntervalMs: 5_000,
}, fetchImpl);

const service = createEnrollmentService(client, {
  provisionTimeoutMs: 180_000,
  serviceAccounts: [{ email: SVC_EMAIL, password: SVC_CPF }],
});

const result = await service.enrollStudent({
  email: studentEmail,
  cpf: studentCpf,
  tag: "cpa2026",
  fullName: "Aluno Prova Opcao2",
  candidateTurmas: [3399], // cohort STALE de propósito
  onLog: (line) => console.log(line),
});

console.log("\n" + "=".repeat(70));
console.log("RESULTADO:", JSON.stringify({ status: result.status, idTurma: result.idTurma, selection: result.turmaSelection }, null, 2));
if (result.status === "CONFIRMED" && Number(result.idTurma) !== 3399) {
  console.log(`OK: service account descobriu a turma mais recente ao vivo (${result.idTurma}) e ignorou o cohort stale (3399).`);
  console.log("OPÇÃO 2 VALIDADA PONTA A PONTA — a matrícula não depende do cohort gravado.");
} else {
  console.log(`verificar: status=${result.status} turma=${result.idTurma}`);
}
console.log("=".repeat(70));
