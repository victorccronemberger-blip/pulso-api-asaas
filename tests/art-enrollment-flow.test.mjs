import assert from "node:assert/strict";
import test from "node:test";
import { createArtClient } from "../src/integrations/art/client.js";
import { createEnrollmentService } from "../src/integrations/art/enrollment.js";

// Mock da plataforma ART. Roteia por URL e registra chamadas para assercoes.
function artPlatformMock({ dynamicTurmas, activeOnPrepare = new Set() } = {}) {
  const calls = [];
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    calls.push({ path, search: u.search, method: options.method ?? "GET" });

    if (path === "/api/login") {
      return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 204999 } } });
    }
    if (path === "/v1/checkout/prepare") {
      const tag = u.searchParams.get("tag");
      const idTurma = u.searchParams.get("id_turma");
      // probe do carrier (cpa2026/4058) sempre responde; demais so se ativos
      if (tag === "cpa2026" && idTurma === "4058") return json({ course: { tag_curso: tag, nome: "CPA", valor_curso: 1500 } });
      if (activeOnPrepare.has(`${tag}:${idTurma}`)) {
        return json({ course: { tag_curso: tag, nome: "Curso", valor_curso: 9997, data_fim_vendas: "2026-09-18" }, financialInstitions: [{ id: 998 }] });
      }
      return json({ error: "Course not found" }, 404);
    }
    if (path === "/v1/services/turmas") {
      // endpoint patcheado: so responde com RS256 real (o mock aceita o token do aluno)
      const auth = options.headers?.Authorization ?? options.headers?.authorization ?? "";
      if (auth !== "Bearer rs256-real-do-aluno") return json({ message: "Unauthenticated." }, 401);
      return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    }
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") return json({ ok: true }, 200);
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      const auth = options.headers?.Authorization ?? options.headers?.authorization ?? "";
      if (auth !== "Bearer rs256-real-do-aluno") return json({ message: "Unauthenticated." }, 401);
      return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4155, valor: 0 }]);
    }
    return json({ error: "not found" }, 404);
  }
  return { calls, fetchImplementation: (url, options) => handler(url, options) };
}

test("enrollStudent: provisão por cohort + descoberta dinâmica RS256 confirma a turma e efetiva", async () => {
  const dynamicTurmas = [
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
    { id_turma: 4075, tag_curso: "cfp-2026_54", nome: "T1", ativa: 1, data_inicio_aulas: "2026-07-02" },
    { id_turma: 9999, tag_curso: "outra-tag", nome: "outra", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  const mock = artPlatformMock({
    dynamicTurmas,
    activeOnPrepare: new Set(["cfp-2026_54:4155", "cfp-2026_54:4075"]),
  });
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 2000 }, mock.fetchImplementation);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "cliente@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Cliente Real",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.idTurma, 4155, "deve manter a turma de provisão (cohort) pois ela continua ativa na descoberta dinâmica");
  assert.equal(result.userId, "204999");
  assert.equal(result.enrollment.tag, "cfp-2026_54");

  // a descoberta dinâmica PRECISOU do RS256 (listagem aconteceu com o token do aluno)
  const turmasCalls = mock.calls.filter((c) => c.path === "/v1/services/turmas");
  assert.ok(turmasCalls.length >= 1, "deve ter listado turmas dinamicamente");
  // a confirmação final veio do findCoursesByStudent com RS256
  assert.ok(mock.calls.some((c) => c.path === "/v1/services/aluno/findCoursesByStudent"));
  // a descoberta dinâmica confirmou a provisão (log)
  assert.ok(logs.some((l) => l.includes("dinamica confirmou provisao 4155")), logs.join("\n"));
});

test("enrollStudent: se a turma de provisão sai do ar, a descoberta dinâmica TROCA para a vigente real", async () => {
  const dynamicTurmas = [
    { id_turma: 4075, tag_curso: "cfp-2026_54", nome: "T1", ativa: 1, data_inicio_aulas: "2026-07-02" },
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  const base = artPlatformMock({
    dynamicTurmas,
    activeOnPrepare: new Set(["cfp-2026_54:4155", "cfp-2026_54:4075"]),
  });
  // 1ª chamada de prepare para 4155 (provisão) responde 200; a 2ª (descoberta
  // dinâmica) responde 404 — modela a turma caindo entre as duas fases.
  let prepare4155Count = 0;
  const wrapped = (url, options) => {
    const u = new URL(url);
    if (u.pathname === "/v1/checkout/prepare" && u.searchParams.get("id_turma") === "4155") {
      prepare4155Count += 1;
      if (prepare4155Count >= 2) {
        return Promise.resolve(new Response(JSON.stringify({ error: "Course not found" }), { status: 404 }));
      }
    }
    return base.fetchImplementation(url, options);
  };
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 2000 }, wrapped);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "cliente2@example.com",
    cpf: "19100000001",
    tag: "cfp-2026_54",
    fullName: "Cliente Dois",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.idTurma, 4075, "deve trocar para a turma vigente quando a de provisão sai do ar");
  assert.ok(logs.some((l) => l.includes("dinamica TROCOU")), logs.join("\n"));
});

test("enrollStudent: polling sobrevive a 401 renovando a sessao (rotacao de token)", async () => {
  // Modela a guerra de tokens vista em producao: outra sessao da MESMA conta
  // loga no meio do polling e revoga o RS256 corrente. O waitForEnrollment nao
  // pode morrer no 401 — renova a sessao e continua esperando aprovacao.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  let logins = 0;
  let currentToken = "";
  const dynamicTurmas = [
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") {
      logins += 1;
      currentToken = `rs256-v${logins}`;
      return json({ response: { status: "SUCCESS", data: { token: currentToken, id: 204999 } } });
    }
    if (path === "/v1/checkout/prepare") return json({ course: { tag_curso: "cfp-2026_54", nome: "Curso", valor_curso: 9997 } });
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") return json({ error: ["Ops! O seu pagamento está sendo processado."] }, 400);
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      const auth = options.headers?.Authorization ?? options.headers?.authorization ?? "";
      if (auth !== `Bearer ${currentToken}`) return json({ message: "Unauthenticated." }, 401);
      if (logins < 2) {
        // outra sessao logou: o token atual vira lixo a partir do proximo probe
        currentToken = "rs256-revogado-externamente";
        return json([]);
      }
      return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4155 }]);
    }
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 5000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "guerra@example.com",
    cpf: "19100000003",
    tag: "cfp-2026_54",
    fullName: "Cliente Guerra",
    onLog: (line) => logs.push(line),
  });

  assert.equal(logins, 2, "precisou de um re-login depois da rotação");
  assert.equal(result.status, "CONFIRMED", "polling sobreviveu ao 401 e confirmou a matrícula");
  assert.ok(logs.some((l) => l.includes("sessao renovada apos 401")), logs.join("\n"));
});

test("enrollStudent: sem conta de serviço, a listagem com carrier alg=none é rejeitada (401) mas o fluxo segue via cohort", async () => {
  // dynamicTurmas vazio simula listagem dinâmica indisponível; cohort 4155 ainda ativa.
  const mock = artPlatformMock({
    dynamicTurmas: [],
    activeOnPrepare: new Set(["cfp-2026_54:4155"]),
  });
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 2000 }, mock.fetchImplementation);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "cliente3@example.com",
    cpf: "19100000002",
    tag: "cfp-2026_54",
    fullName: "Cliente Tres",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.idTurma, 4155, "fallback: mantém a provisão por cohort quando a dinâmica não lista nada");
});
