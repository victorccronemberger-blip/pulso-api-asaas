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
    carrierToken: "qualquer",
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

test("enrollStudent: cohort do catalogo morto cai na descoberta RS256 da conta", async () => {
  // Produção 2026-07-29: tag cfp_modular_12345678 com cohort 3629 sem checkout
  // ativo (prepare 404). O fluxo NÃO pode morrer — loga na conta do comprador,
  // lista as turmas vivas e escolhe uma delas.
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const dynamicTurmas = [
    { id_turma: 4097, tag_curso: "cfp_modular_12345678", nome: "Modular T9", ativa: 1, data_inicio_aulas: "2026-08-01" },
    { id_turma: 4100, tag_curso: "outra_tag", nome: "outra", ativa: 1, data_inicio_aulas: "2026-08-01" },
  ];
  async function handler(url, options = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/api/login") return json({ response: { status: "SUCCESS", data: { token: "rs256-real-do-aluno", id: 11833 } } });
    if (path === "/v1/checkout/prepare") {
      const tag = u.searchParams.get("tag");
      const idTurma = u.searchParams.get("id_turma");
      if (tag === "cpa2026" && idTurma === "4058") return json({ course: { tag_curso: tag, nome: "CPA", valor_curso: 1500 } });
      if (tag === "cfp_modular_12345678" && idTurma === "4097") return json({ course: { tag_curso: tag, nome: "Modular", valor_curso: 4998 } });
      return json({ error: "Course not found" }, 404);
    }
    if (path === "/v1/services/turmas") return json({ current_page: 1, last_page: 1, data: dynamicTurmas });
    if (path === "/v1/checkout/findStudent") return json({ error: "not found" }, 404);
    if (path === "/v1/services/student/metrics") return json({}, 405);
    if (path === "/v1/checkout/process/start") return json({ ok: true }, 200);
    if (path === "/v1/services/aluno/findCoursesByStudent") return json([{ tag: "cfp_modular_12345678", status: "APPROVED", id_turma: 4097 }]);
    return json({ error: "not found" }, 404);
  }
  const client = createArtClient({ pollIntervalMs: 1, pollTimeoutMs: 2000 }, handler);
  const service = createEnrollmentService(client, { provisionTimeoutMs: 2000 });

  const logs = [];
  const result = await service.enrollStudent({
    email: "modular@example.com",
    cpf: "19100000000",
    tag: "cfp_modular_12345678",
    fullName: "Cliente Modular",
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.idTurma, 4097, "matriculou na turma descoberta via RS256, não no cohort morto do catálogo");
  assert.ok(logs.some((l) => l.includes("catalogo sem turma ativa")), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("descoberta-RS256 resolveu provisao 4097")), logs.join("\n"));
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
