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
      // cpa2026/4058 sempre responde; demais so se ativos
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

test("resolveTurma escolhe a turma mais recente com checkout ativo (regra do contrato)", async () => {
  const mock = artPlatformMock({
    dynamicTurmas: [],
    activeOnPrepare: new Set(["cfp-2026_54:4101", "cfp-2026_54:4099"]),
  });
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 100 }, mock.fetchImplementation);
  const service = createEnrollmentService(client, {});
  const logs = [];
  const turma = await service.resolveTurma({
    tag: "cfp-2026_54",
    candidateTurmas: [4099, 4101],
    xApiKey: "qualquer",
    onLog: (line) => logs.push(line),
  });
  assert.equal(turma.idTurma, 4101, "regra vigente: a turma MAIS RECENTE vence");
  assert.equal(turma.selectionReason, "turma-mais-recente");
});

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

test("enrollStudent: provisiona conta nova com os dados reais do comprador", async () => {
  // Fase 1 (conta inexistente): o payload de provisionamento precisa nascer com
  // telefone, nascimento e endereço REAIS do pedido — nunca defaults fabricados.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  let logins = 0;
  let phase1Payload = null;
  const dynamicTurmas = [
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") {
      logins += 1;
      if (logins === 1) return json({ response: { status: "ERROR", message: "credenciais invalidas" } });
      return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 11833 } } });
    }
    if (path === "/v1/checkout/prepare") return json({ course: { tag_curso: "cfp-2026_54", nome: "Curso", valor_curso: 9997 } });
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ error: "not found" }, 404);
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") {
      phase1Payload ??= JSON.parse(String(options.body ?? "{}"));
      return json({ error: "Ops! Houve um erro inesperado" }, 500);
    }
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      const auth = options.headers?.Authorization ?? options.headers?.authorization ?? "";
      if (auth !== "Bearer rs256-real-do-aluno") return json({ message: "Unauthenticated." }, 401);
      return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4155 }]);
    }
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 8000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 20_000 });

  const result = await service.enrollStudent({
    email: "nova.aluna@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Nova Aluna",
    phone: "11977776666",
    birthDate: "1992-03-15",
    address: {
      postCode: "01310930",
      street: "Av Paulista",
      number: "1000",
      complement: "Cj 21",
      district: "Bela Vista",
      city: "Sao Paulo",
      state: "SP",
    },
    onLog: () => {},
  });

  assert.equal(result.status, "CONFIRMED");
  assert.ok(phase1Payload, "fase 1 enviou payload de provisionamento");
  assert.equal(phase1Payload.phone_number, "11977776666");
  assert.equal(phase1Payload.birth_date, "1992-03-15");
  assert.equal(phase1Payload.street, "Av Paulista");
  assert.equal(phase1Payload.number, "1000");
  assert.equal(phase1Payload.district, "Bela Vista");
  assert.equal(phase1Payload.city, "Sao Paulo");
  assert.equal(phase1Payload.state, "SP");
  assert.equal(phase1Payload.post_code, "01310930");
});

test("enrollStudent: payload de provisão é FIEL à SPA (card RSA, detailsCupom objeto, fingerprint) e a fase 1 roda sem Bearer", async () => {
  // O coração da elevação (pesquisa 2026-07-29, JWT real): o provisionamento
  // (fase 1) roda SÓ com x-api-key — sem Bearer, sem nenhum token alg=none — e o
  // payload precisa ser fiel à SPA: cartão cifrado RSA em chunks de 100 chars,
  // detailsCupom objeto, getnet_fingerprint, promo_opt_in, contract:true.
  // Payloads "pobres" (card:"", detailsCupom:"") crasham antes de provisionar.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  let logins = 0;
  let phase1 = null;
  let phase1Headers = null;
  const dynamicTurmas = [
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") {
      logins += 1;
      if (logins === 1) return json({ response: { status: "ERROR", message: "credenciais invalidas" } });
      return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 11833 } } });
    }
    if (path === "/v1/checkout/prepare") return json({ course: { tag_curso: "cfp-2026_54", nome: "Curso", valor_curso: 9997 } });
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ error: "not found" }, 404);
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") {
      phase1 ??= JSON.parse(String(options.body ?? "{}"));
      phase1Headers ??= options.headers;
      return json({ error: "Ops!" }, 500);
    }
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      const auth = options.headers?.Authorization ?? options.headers?.authorization ?? "";
      if (auth !== "Bearer rs256-real-do-aluno") return json({ message: "Unauthenticated." }, 401);
      return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4155 }]);
    }
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 8000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 20_000 });

  const result = await service.enrollStudent({
    email: "fiel@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Payload Fiel",
    onLog: () => {},
  });

  assert.equal(result.status, "CONFIRMED");
  assert.ok(phase1, "fase 1 enviou payload");
  // tipo gratuito + flags fiéis à SPA
  assert.equal(phase1.type, "free");
  assert.equal(phase1.contract, true);
  assert.equal(phase1.contractPrivacity, true);
  assert.equal(phase1.promo_opt_in, false);
  // detailsCupom é OBJETO (não a string vazia do payload pobre)
  assert.deepEqual(phase1.detailsCupom, { valid: false, cashValue: 0, value: 0 });
  // getnet_fingerprint presente (32 hex)
  assert.match(phase1.getnet_fingerprint, /^[0-9a-f]{32}$/);
  // card é string JSON de array de chunks RSA-1024 (cada chunk decodifica p/ 128 bytes)
  assert.equal(typeof phase1.card, "string");
  const chunks = JSON.parse(phase1.card);
  assert.ok(Array.isArray(chunks) && chunks.length >= 1, "card é array de chunks cifrados");
  for (const chunk of chunks) {
    assert.equal(Buffer.from(chunk, "base64").length, 128, "cada chunk é RSA-1024 (128 bytes)");
  }
  // FASE 1 sem Bearer: provisionamento só com x-api-key (sem alg=none, sem RS256)
  const auth = phase1Headers?.Authorization ?? phase1Headers?.authorization;
  assert.equal(auth, undefined, "fase 1 NÃO envia Authorization (provisionamento só com x-api-key)");
});

test("enrollStudent: cohort morto + scan vazio → descoberta RS256 da conta resolve", async () => {
  // Última camada dinâmica: catálogo morto, scan adaptativo não alcança a turma
  // (id fora das faixas), mas a conta do comprador existe → listagem RS256 real.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const dynamicTurmas = [
    { id_turma: 5000, tag_curso: "cfp-2026_54", nome: "Turma nova distante", ativa: 1, data_inicio_aulas: "2026-09-01" },
    { id_turma: 5001, tag_curso: "outra_tag", nome: "outra", ativa: 1, data_inicio_aulas: "2026-09-01" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 11833 } } });
    if (path === "/v1/checkout/prepare") {
      const tag = u.searchParams.get("tag");
      const idTurma = u.searchParams.get("id_turma");
      if (tag === "cpa2026" && idTurma === "4058") return json({ course: { tag_curso: tag, nome: "CPA", valor_curso: 1500 } });
      if (tag === "cfp-2026_54" && idTurma === "5000") return json({ course: { tag_curso: tag, nome: "CFP", valor_curso: 4998 } });
      return json({ error: "Course not found" }, 404);
    }
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ error: "not found" }, 404);
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") return json({ ok: true }, 200);
    if (path === "/v1/services/aluno/findCoursesByStudent") return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 5000 }]);
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 2000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "distante@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Cliente Distante",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.idTurma, 5000, "descoberta RS256 achou a turma fora das faixas de scan");
  assert.ok(logs.some((l) => l.includes("catalogo sem turma ativa")), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("descoberta-RS256 resolveu provisao 5000")), logs.join("\n"));
});

test("enrollStudent: service-account lista turmas em tempo real (camada primaria dinamica)", async () => {
  // Com ART_SERVICE_ACCOUNTS configurado, a descoberta usa login dedicado +
  // listagem real de /v1/services/turmas — nenhum id hardcoded no caminho.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const dynamicTurmas = [
    { id_turma: 4160, tag_curso: "cfp-2026_54", nome: "Turma atual", ativa: 1, data_inicio_aulas: "2026-08-10" },
    { id_turma: 4158, tag_curso: "cfp-2026_54", nome: "Turma anterior", ativa: 1, data_inicio_aulas: "2026-07-01" },
    { id_turma: 4161, tag_curso: "outra_tag", nome: "outra", ativa: 1, data_inicio_aulas: "2026-08-12" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") {
      const body = JSON.parse(String(options.body ?? "{}"));
      const token = body.email === "svc@pulso.test" ? "rs256-svc" : "rs256-comprador";
      return json({ response: { status: "SUCCESS", data: { token, id: 999 } } });
    }
    if (path === "/v1/checkout/prepare") {
      const tag = u.searchParams.get("tag");
      const idTurma = u.searchParams.get("id_turma");
      if (tag === "cpa2026" && idTurma === "4058") return json({ course: { tag_curso: tag, nome: "CPA", valor_curso: 1500 } });
      if (tag === "cfp-2026_54" && (idTurma === "4160" || idTurma === "4158")) return json({ course: { tag_curso: tag, nome: "CFP", valor_curso: 4998, data_inicio: idTurma === "4160" ? "2026-08-10" : "2026-07-01" } });
      return json({ error: "Course not found" }, 404);
    }
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ error: "not found" }, 404);
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") return json({ ok: true }, 200);
    if (path === "/v1/services/aluno/findCoursesByStudent") return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4160 }]);
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 2000 }, handler);
  const service = createEnrollmentService(client, {
    provisionTimeoutMs: 2000,
    serviceAccounts: [{ email: "svc@pulso.test", password: "19100000000" }],
  });

  const logs = [];
  const result = await service.enrollStudent({
    email: "comprador@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Comprador Service",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.idTurma, 4160, "regra vigente: a turma MAIS RECENTE da listagem real");
  assert.ok(logs.some((l) => l.includes("service-account svc@pulso.test: 2 turma(s) viva(s) em tempo real")), logs.join("\n"));
});

test("enrollStudent: order PENDING zumbi é deletada e o re-enroll nasce APPROVED (recovery)", async () => {
  // Caminho Karine/determinístico da pesquisa: a order PENDING travada bloqueia
  // re-enroll com 400 e não flipa. O recovery localiza SÓ a order PENDING da
  // tag/turma, deleta e re-envia — a nova order nasce APPROVED. Orders PENDING
  // de outros cursos do mesmo aluno não podem ser tocadas.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const deleted = [];
  let enrollCalls = 0;
  let approvedNow = false;
  const dynamicTurmas = [
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 11833 } } });
    if (path === "/v1/checkout/prepare") return json({ course: { tag_curso: "cfp-2026_54", nome: "Curso", valor_curso: 9997 } });
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ id_usuario: 555777, nome: "Karine", sobre_nome: "Santiago", documento: "191.000.000-00" });
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/services/aluno/findOrdersByStudent") {
      return json({ data: { orders: [
        { id_order: 9990001, status: "PENDING", id_turma: 4155, curso: "CFP 60 dias" },
        { id_order: 9990002, status: "APPROVED", id_turma: 1111, curso: "Outro curso", tag: "cfa_2025" },
        { id_order: 9990003, status: "PENDING", id_turma: 2222, tag: "cproi2026", curso: "CPRO-I" },
      ] } });
    }
    if (path.startsWith("/v1/crud/orders/")) {
      deleted.push(path.split("/").pop());
      return new Response("1", { status: 200 });
    }
    if (path === "/v1/checkout/process/start") {
      enrollCalls += 1;
      if (enrollCalls === 1) return json({ error: ["Ops! O seu pagamento está sendo processado."] }, 400);
      approvedNow = true;
      return json({ ok: true }, 200);
    }
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      return json(approvedNow ? [{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4155 }] : []);
    }
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 3000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "karine@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Karine Santiago",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.recoveredOrderId, 9990001, "recuperou deletando exatamente a order PENDING da turma");
  assert.deepEqual(deleted, ["9990001"], "somente a order certa foi deletada — as outras ficaram intactas");
  assert.equal(enrollCalls, 2, "um re-enroll limpo após o delete");
  assert.ok(logs.some((l) => l.includes("DELETE order 9990001")), logs.join("\n"));
});

test("enrollStudent: conta nova + cohort morto — scan prepare acha a turma viva e provisiona", async () => {
  // Caso cfp_modular_12345678 (produção 2026-07-29): cohort do catálogo morto
  // (3629 → 404) e comprador sem conta na plataforma (login falha → sem RS256
  // para listar turmas). O scan via prepare (só x-api-key, sem nenhum token
  // alg=none) varre a faixa do cohort e encontra a turma viva (3776),
  // permitindo provisionar a conta.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  let logins = 0;
  let enrollCalls = 0;
  const dynamicTurmas = [
    { id_turma: 3776, tag_curso: "cfp_modular_12345678", nome: "Modular T1", ativa: 1, data_inicio_aulas: "2026-05-17" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") {
      logins += 1;
      if (logins < 2) return json({ response: { status: "ERROR", message: "credenciais invalidas" } });
      return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 205000 } } });
    }
    if (path === "/v1/checkout/prepare") {
      const tag = u.searchParams.get("tag");
      const idTurma = u.searchParams.get("id_turma");
      if (tag === "cpa2026" && idTurma === "4058") return json({ course: { tag_curso: tag, nome: "CPA", valor_curso: 1500 } });
      if (tag === "cfp_modular_12345678" && idTurma === "3776") return json({ course: { tag_curso: tag, nome: "Modular", valor_curso: 9997, data_inicio: "2026-05-17" } });
      return json({ error: "Course not found" }, 404);
    }
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ error: "not found" }, 404);
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") {
      enrollCalls += 1;
      return enrollCalls === 1 ? json({ error: "Ops!" }, 500) : json({ ok: true }, 200);
    }
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      const auth = options.headers?.Authorization ?? options.headers?.authorization ?? "";
      if (auth !== "Bearer rs256-real-do-aluno") return json({ message: "Unauthenticated." }, 401);
      return json(enrollCalls >= 2 ? [{ tag: "cfp_modular_12345678", status: "APPROVED", id_turma: 3776 }] : []);
    }
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 8000 }, handler);
  const settingsWrites = [];
  const fakeStore = {
    getSetting: async () => null,
    setSetting: async (key, value) => { settingsWrites.push([key, value]); },
  };
  const service = createEnrollmentService(client, { provisionTimeoutMs: 20_000, store: fakeStore });

  const logs = [];
  const result = await service.enrollStudent({
    email: "modular.nova@example.com",
    cpf: "19100000000",
    tag: "cfp_modular_12345678",
    fullName: "Cliente Modular Nova",
    candidateTurmas: ["3629"],
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.idTurma, 3776, "turma viva descoberta pelo scan prepare");
  assert.ok(logs.some((l) => l.includes("scan prepare achou 1 turma(s) ativa(s): 3776")), logs.join("\n"));
  assert.deepEqual(settingsWrites[0], ["art-scan-frontier:cfp_modular_12345678", 4030], "fronteira persistida para a proxima execucao");
});

test("polling: 500 'id_usuario' re-dispara o sync do perfil e confirma (finding #3)", async () => {
  // 08-FLUXO-DETERMINISTICO: findCoursesByStudent 500 com 'id_usuario non-object'
  // significa que a linha do aluno ainda não existe. O polling re-dispara o
  // side effect do student/metrics e continua — não queima a tentativa.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  let metricsCalls = 0;
  let findCalls = 0;
  const dynamicTurmas = [
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 11833 } } });
    if (path === "/v1/checkout/prepare") return json({ course: { tag_curso: "cfp-2026_54", nome: "Curso", valor_curso: 9997 } });
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ error: "not found" }, 404);
    if (path === "/v1/services/student/metrics") { metricsCalls += 1; return json({}, 405); }
    if (path === "/v1/checkout/process/start") return json({ ok: true }, 200);
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      findCalls += 1;
      if (findCalls === 1) return json({ error: "Trying to get property 'id_usuario' of non-object" }, 500);
      return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4155 }]);
    }
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 3000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "perfil-lento@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Perfil Lento",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.ok(metricsCalls >= 2, `student/metrics re-disparado no 500 id_usuario (calls=${metricsCalls})`);
  assert.ok(logs.some((l) => l.includes("perfil ausente -> re-sync")), logs.join("\n"));
});

test("enrollStudent: alinha o documento ao perfil ja registrado na plataforma (mismatch de CPF)", async () => {
  // Caso Karine (producao 2026-07-29): conta existente com documento A no perfil
  // da plataforma, pedido PULSO com documento B. A fase 2 precisa mandar o
  // documento DO PERFIL, senao a plataforma responde 500.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  let capturedPayload = null;
  const dynamicTurmas = [
    { id_turma: 4155, tag_curso: "cfp-2026_54", nome: "10 anos", ativa: 1, data_inicio_aulas: "2026-07-02" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 11833 } } });
    if (path === "/v1/checkout/prepare") return json({ course: { tag_curso: "cfp-2026_54", nome: "Curso", valor_curso: 9997 } });
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") {
      return json({
        nome: "Karine", sobre_nome: "Santiago",
        documento: "529.982.030-91", telefone: "(11) 98888-7777",
        dt_nascimento: "1985-05-10", cidade: "Campinas", uf: "SP",
        rua: "Rua Real", numero: "45", bairro: "Jardim", cep: "13000-000",
      });
    }
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") {
      capturedPayload = JSON.parse(String(options.body ?? "{}"));
      return json({ ok: true }, 200);
    }
    if (path === "/v1/services/aluno/findCoursesByStudent") {
      const auth = options.headers?.Authorization ?? options.headers?.authorization ?? "";
      if (auth !== "Bearer rs256-real-do-aluno") return json({ message: "Unauthenticated." }, 401);
      return json([{ tag: "cfp-2026_54", status: "APPROVED", id_turma: 4155 }]);
    }
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 2000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "karine@example.com",
    cpf: "19100000000",
    tag: "cfp-2026_54",
    fullName: "Karine Do Pedido",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.ok(capturedPayload, "fase 2 enviou payload");
  assert.equal(capturedPayload.document_number, "52998203091", "documento veio do perfil da plataforma");
  assert.equal(capturedPayload.full_name, "Karine Santiago");
  assert.equal(capturedPayload.phone_number, "11988887777");
  assert.equal(capturedPayload.city, "Campinas");
  assert.ok(logs.some((l) => l.includes("DIFERENTE do pedido")), logs.join("\n"));
});

test("enrollStudent: sem conta de serviço e listagem dinâmica vazia, o fluxo segue via cohort", async () => {
  // dynamicTurmas vazio simula listagem dinâmica indisponível (o RS256 do
  // comprador não lista turmas ativas para a tag); cohort 4155 ainda ativa.
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
