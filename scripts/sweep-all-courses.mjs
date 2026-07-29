// Varredura completa: matricula UM aluno em TODOS os cursos ativos via engine real.
// Usa service account para descoberta ao vivo + regra da penúltima turma.
// Timeout de 30s por curso (fail-fast). No final, lista resultados e limpa orders.
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

// todos os 28 cursos ativos do catálogo
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

function genCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  let c1 = d.reduce((s, v, i) => s + (10 - i) * v, 0) % 11; c1 = c1 < 2 ? 0 : 11 - c1;
  const d2 = [...d, c1];
  let c2 = d2.reduce((s, v, i) => s + (11 - i) * v, 0) % 11; c2 = c2 < 2 ? 0 : 11 - c2;
  return [...d, c1, c2].join("");
}

const studentEmail = `aluno.sweep.${Date.now().toString().slice(-6)}@gmail.com`;
const studentCpf = genCpf();
console.log(`aluno de teste: ${studentEmail} cpf=${studentCpf}\n`);

const client = createArtClient(
  { apiOrigin: API, idmOrigin: IDM, requestTimeoutMs: 35_000, pollTimeoutMs: 30_000, pollIntervalMs: 5_000 },
  (url, o = {}) => fetch(url, { ...o, dispatcher }),
);
const service = createEnrollmentService(client, {
  provisionTimeoutMs: 90_000,
  serviceAccounts: [{ email: SVC_EMAIL, password: SVC_CPF }],
});

const results = [];
for (const [slug, tag] of COURSES) {
  const t0 = Date.now();
  process.stdout.write(`${tag.padEnd(28)} ... `);
  try {
    const r = await service.enrollStudent({
      email: studentEmail, cpf: studentCpf, tag,
      fullName: "Aluno Sweep", onLog: () => {},
    });
    const ms = Date.now() - t0;
    results.push({ tag, slug, status: r.status, idTurma: r.idTurma, selection: r.turmaSelection, ms });
    console.log(`${r.status} turma=${r.idTurma} (${r.turmaSelection}) ${ms}ms`);
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = String(e).slice(0, 100);
    results.push({ tag, slug, status: "ERROR", error: msg, ms });
    console.log(`ERROR ${ms}ms — ${msg}`);
  }
}

// resumo
console.log("\n" + "=".repeat(80));
const approved = results.filter((r) => r.status === "CONFIRMED");
const pending = results.filter((r) => r.status === "PENDING" || r.status === "TIMEOUT");
const errors = results.filter((r) => r.status === "ERROR");
console.log(`CONFIRMED: ${approved.length}/${results.length}`);
for (const r of approved) console.log(`  ✓ ${r.tag.padEnd(28)} turma=${r.idTurma} (${r.selection}) ${r.ms}ms`);
console.log(`PENDING/TIMEOUT: ${pending.length}`);
for (const r of pending) console.log(`  ~ ${r.tag.padEnd(28)} turma=${r.idTurma ?? "?"} ${r.ms}ms`);
console.log(`ERROR: ${errors.length}`);
for (const r of errors) console.log(`  ✗ ${r.tag.padEnd(28)} ${r.error}`);

// cleanup: login do aluno + delete de todas as orders
console.log("\n" + "=".repeat(80));
console.log("CLEANUP — removendo orders do aluno de teste...");
try {
  const lr = await f(`${IDM}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: studentEmail, password: studentCpf }) });
  const lb = await lr.json();
  const token = lb?.response?.data?.token;
  const userId = lb?.response?.data?.id ?? lb?.response?.data?.user_id;
  if (token && userId) {
    // listar orders
    const or = await f(`${API}/v1/services/aluno/findOrdersByStudent`, {
      method: "POST",
      headers: { "x-api-key": xApiKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id_usuario: Number(userId) }),
    });
    const ob = await or.json();
    const orders = Array.isArray(ob) ? ob : (ob?.data ?? ob?.orders ?? []);
    console.log(`  orders encontradas: ${orders.length}`);
    let deleted = 0;
    for (const o of orders) {
      const dr = await f(`${API}/v1/crud/orders/${encodeURIComponent(String(o.id_order))}`, {
        method: "DELETE", headers: { "x-api-key": xApiKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const dt = await dr.text();
      if (dr.status === 200 && dt.trim() === "1") deleted++;
      console.log(`  DELETE order ${o.id_order} (${o.tag_curso ?? "?"}) -> HTTP ${dr.status} ${dt.slice(0, 20)}`);
    }
    // verificar cursos restantes
    const cr = await f(`${API}/v1/services/aluno/findCoursesByStudent?email=${encodeURIComponent(studentEmail)}`, {
      headers: { "x-api-key": xApiKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const cb = await cr.json();
    const remaining = Array.isArray(cb) ? cb : [];
    console.log(`  cursos após cleanup: ${remaining.length}`);
    for (const c of remaining) console.log(`    ainda: ${c.tag} order=${c.id_order}`);
    if (!remaining.length) console.log("  LIMPO — nenhum curso restante.");
  } else {
    console.log("  login do aluno falhou — cleanup manual necessário");
    console.log(`  email: ${studentEmail} cpf: ${studentCpf}`);
  }
} catch (e) {
  console.log("  cleanup erro:", String(e).slice(0, 120));
  console.log(`  aluno: ${studentEmail} cpf: ${studentCpf}`);
}
