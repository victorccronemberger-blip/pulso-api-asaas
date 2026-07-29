// Valida TODOS os cursos ativos: descoberta da penúltima turma (service account)
// + prepare + valor. E faz matrícula COMPLETA nos urgentes (CFP e CFA) com um
// único aluno de teste (provisiona 1x, reutiliza a conta nos demais cursos).
import { Agent } from "undici";
import { generateXApiKey } from "../src/integrations/art/credentials.js";
import { createArtClient } from "../src/integrations/art/client.js";
import { createEnrollmentService } from "../src/integrations/art/enrollment.js";

const SVC_EMAIL = "svc.turmas.pulso.40387859@gmail.com";
const SVC_CPF = "05938277752";
const API = "https://api.academiarafaeltoro.com.br";
const IDM = "https://ms-idm.academiarafaeltoro.com.br";
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const f = (url, o = {}) => fetch(url, { ...o, dispatcher });
const xApiKey = generateXApiKey();

const COURSES = [
  ["10-anos-art-vitalicio", "10anos_anivertoro"], ["agropulse", "agropulse"],
  ["ancord-2026", "ancord-2026"], ["biblia-simulados-cfp-2026", "biblia-cfp_2026_1"],
  ["cfa-combo-l1-l2-l3", "cfa-combol1l2l3"], ["cfa-level-ii", "CFALevelII-ART"],
  ["cfg-2026", "cfg_2026"], ["cfp-60-dias-exame-54", "cfp-2026_54"],
  ["cfp-modular-completo", "cfp_modular_12345678"], ["cga-2026", "CGA_2026"],
  ["cge-2026", "cge-2026"], ["cnpi-conteudo-brasileiro", "CNPI-CB_2026"],
  ["cnpi-conteudo-global", "cnpi-cg_2026"], ["cnpi-conteudo-tecnico", "cnpi-tc_2026"],
  ["novo-cpa", "cpa2026"], ["cpro-i", "cproi2026"], ["cpro-r", "cpror2026"],
  ["excel-basico-mercado-financeiro", "excelbasicomf"], ["gerente-relacionamento", "grelacionamento"],
  ["ia-excel-mercado-financeiro", "iamf_excel"], ["ia-mercado-financeiro", "iamf"],
  ["investimentos", "artpinvestimentos"], ["lidero-2026", "lidero_2026"],
  ["masterclass-lideranca", "masterclassARTperf"], ["matematica-financeira-2024-2026", "matematica-financeira_2026"],
  ["plano-financeiro-cfp", "planofinanceiro_2026"], ["renovacao-cfp", "renovacao-cfp"],
  ["risco-e-credito", "riscocredito2"],
];
const URGENT = new Set(["cfp-2026_54", "cfp_modular_12345678", "biblia-cfp_2026_1", "planofinanceiro_2026", "renovacao-cfp", "cfa-combol1l2l3", "CFALevelII-ART"]);

function genCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  let c1 = d.reduce((s, v, i) => s + (10 - i) * v, 0) % 11; c1 = c1 < 2 ? 0 : 11 - c1;
  const d2 = [...d, c1];
  let c2 = d2.reduce((s, v, i) => s + (11 - i) * v, 0) % 11; c2 = c2 < 2 ? 0 : 11 - c2;
  return [...d, c1, c2].join("");
}

// ---- login service account + lista todas as turmas ----
const lr = await f(`${IDM}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: SVC_EMAIL, password: SVC_CPF }) });
const token = (await lr.json()).response.data.token;
let page = 1; const allTurmas = [];
while (page <= 100) {
  const tr = await f(`${API}/v1/services/turmas?page=${page}`, { headers: { "x-api-key": xApiKey, Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const b = await tr.json().catch(() => null);
  if (tr.status !== 200 || !Array.isArray(b?.data)) break;
  allTurmas.push(...b.data);
  if (page >= Number(b.last_page ?? page)) break;
  page += 1;
}
console.log(`Total de turmas na ART: ${allTurmas.length}\n`);

function turmasDe(tag) {
  return allTurmas
    .filter((t) => t.ativa === 1 && String(t.tag_curso ?? "") === tag)
    .sort((a, b) => (Date.parse(b.data_inicio_aulas ?? 0) - Date.parse(a.data_inicio_aulas ?? 0)) || (Number(b.id_turma) - Number(a.id_turma)));
}
async function checkPrepare(tag, idTurma) {
  const r = await f(`${API}/v1/checkout/prepare?tag=${encodeURIComponent(tag)}&id_turma=${idTurma}`, { headers: { "x-api-key": xApiKey, Accept: "application/json" } });
  const b = await r.json().catch(() => null);
  return { http: r.status, valor: b?.course?.valor_curso ?? null, nome: b?.course?.nome ?? null };
}

// ---- FASE 1: validação da penúltima para TODOS os cursos ----
console.log("=== FASE 1: validação da penúltima turma (todos os cursos) ===");
const discovery = [];
for (const [slug, tag] of COURSES) {
  const ativas = turmasDe(tag);
  if (!ativas.length) {
    discovery.push({ slug, tag, status: "SEM_TURMA_ATIVA" });
    console.log(`${tag.padEnd(28)} !! SEM TURMA ATIVA`);
    continue;
  }
  const pen = ativas.length >= 2 ? ativas[1] : ativas[0];
  const sel = ativas.length >= 2 ? "penultima" : "unica";
  const prep = await checkPrepare(tag, pen.id_turma);
  const free = prep.valor === 0;
  discovery.push({ slug, tag, total: ativas.length, ultima: ativas[0].id_turma, penultima: pen.id_turma, selection: sel, prepareHttp: prep.http, penultimaValor: prep.valor, free, nome: prep.nome });
  console.log(`${tag.padEnd(28)} turmas=${String(ativas.length).padStart(2)} penultima=${String(pen.id_turma).padEnd(5)} (${sel.padEnd(9)}) valor=${String(prep.valor).padEnd(6)} ${free ? "FREE ok" : "PAGA !!"} prep=${prep.http} ${prep.nome ?? ""}`);
}

// ---- FASE 2: matrícula completa nos urgentes (CFP + CFA) ----
console.log("\n=== FASE 2: matrícula completa nos urgentes (CFP + CFA) ===");
const studentEmail = `aluno.teste.cursos.${Date.now().toString().slice(-6)}@gmail.com`;
const studentCpf = genCpf();
console.log(`aluno de teste: ${studentEmail} cpf=${studentCpf}\n`);

const client = createArtClient({ apiOrigin: API, idmOrigin: IDM, requestTimeoutMs: 35_000, pollTimeoutMs: 60_000, pollIntervalMs: 5_000 }, (url, o = {}) => fetch(url, { ...o, dispatcher }));
const service = createEnrollmentService(client, { provisionTimeoutMs: 180_000, serviceAccounts: [{ email: SVC_EMAIL, password: SVC_CPF }] });

const enrollResults = [];
for (const [slug, tag] of COURSES.filter(([, t]) => URGENT.has(t))) {
  process.stdout.write(`matriculando ${tag} ... `);
  try {
    const r = await service.enrollStudent({ email: studentEmail, cpf: studentCpf, tag, fullName: "Aluno Teste Cursos", onLog: () => {} });
    enrollResults.push({ tag, status: r.status, idTurma: r.idTurma, selection: r.turmaSelection });
    console.log(`${r.status} turma=${r.idTurma} (${r.turmaSelection})`);
  } catch (e) {
    enrollResults.push({ tag, status: "ERROR", error: String(e).slice(0, 120) });
    console.log(`ERROR: ${String(e).slice(0, 120)}`);
  }
}

// ---- resumo ----
console.log("\n=== RESUMO ===");
const semTurma = discovery.filter((d) => d.status === "SEM_TURMA_ATIVA");
const pagas = discovery.filter((d) => d.free === false);
const ok = discovery.filter((d) => d.free === true);
console.log(`descoberta: ${ok.length} OK (penultima free), ${pagas.length} penultima PAGA (atencao), ${semTurma.length} sem turma ativa`);
if (pagas.length) console.log(`  penultima PAGA: ${pagas.map((d) => `${d.tag}(${d.penultima}=${d.penultimaValor})`).join(", ")}`);
if (semTurma.length) console.log(`  sem turma ativa: ${semTurma.map((d) => d.tag).join(", ")}`);
console.log(`matriculas urgentes: ${enrollResults.filter((r) => r.status === "CONFIRMED").length}/${enrollResults.length} CONFIRMED`);
for (const r of enrollResults) console.log(`  ${r.tag.padEnd(26)} ${r.status}${r.idTurma ? ` turma=${r.idTurma}` : ""}${r.error ? ` ${r.error}` : ""}`);
