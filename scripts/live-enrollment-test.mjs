// Teste ao vivo do motor de matrícula refactorado (JWT real, SEM alg=none)
// contra a plataforma ART real. Exercita createArtClient + createEnrollmentService.
//
// Uso:
//   node scripts/live-enrollment-test.mjs [email] [cpf] [tag] [idTurma]
//   node scripts/live-enrollment-test.mjs                          # defaults: cpa2026/4058
//   node scripts/live-enrollment-test.mjs foo@x.com 11144477735 cproi2026 4114
import { Agent } from "undici";
import { createArtClient } from "../src/integrations/art/client.js";
import { createEnrollmentService } from "../src/integrations/art/enrollment.js";

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const fetchImplementation = (url, options = {}) => fetch(url, { ...options, dispatcher });

function genCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  let c1 = d.reduce((s, v, i) => s + (10 - i) * v, 0) % 11;
  c1 = c1 < 2 ? 0 : 11 - c1;
  const d2 = [...d, c1];
  let c2 = d2.reduce((s, v, i) => s + (11 - i) * v, 0) % 11;
  c2 = c2 < 2 ? 0 : 11 - c2;
  return [...d, c1, c2].join("");
}

const email = process.argv[2] ?? `poc-motor-${Date.now().toString().slice(-6)}@jobraux.com`;
const cpf = process.argv[3] ?? genCpf();
const tag = process.argv[4] ?? "cpa2026";
const idTurma = process.argv[5] ? Number(process.argv[5]) : 4058;

console.log("=".repeat(74));
console.log("TESTE AO VIVO — motor de matrícula (JWT real, sem alg=none)");
console.log(`email=${email} cpf=${cpf} tag=${tag} turma=${idTurma}`);
console.log("=".repeat(74));

const client = createArtClient({
  apiOrigin: "https://api.academiarafaeltoro.com.br",
  idmOrigin: "https://ms-idm.academiarafaeltoro.com.br",
  requestTimeoutMs: 35_000,
  pollTimeoutMs: 60_000,
  pollIntervalMs: 5_000,
}, fetchImplementation);

const service = createEnrollmentService(client, {
  provisionTimeoutMs: 180_000,
  serviceAccounts: [],
});

const result = await service.enrollStudent({
  email,
  cpf,
  tag,
  fullName: "Poc Motor",
  phone: "11999999999",
  birthDate: "1990-01-01",
  address: {
    postCode: "01310930",
    street: "Av Paulista",
    number: "1000",
    district: "Bela Vista",
    city: "Sao Paulo",
    state: "SP",
  },
  candidateTurmas: [idTurma],
  onLog: (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`),
});

console.log("=".repeat(74));
console.log("RESULTADO:");
console.log(JSON.stringify(result, null, 2));
console.log("=".repeat(74));
if (result.status === "CONFIRMED") {
  console.log("MATRICULA CONFIRMADA — motor JWT real funciona ao vivo");
  process.exit(0);
}
console.log(`status=${result.status} — verificar logs acima`);
process.exit(1);
