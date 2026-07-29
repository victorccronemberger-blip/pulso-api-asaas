import { setTimeout as sleep } from "node:timers/promises";
import { forgeTransportJwt, generateXApiKey } from "./credentials.js";
import { getCohortBySourceTag } from "../../domain/catalog.js";

export function buildEnrollPayload({
  tag,
  idTurma,
  email,
  fullName,
  cpf,
  phone = "11999999999",
  birthDate = "1990-01-01",
  financialInstitution = "",
  city = "Sao Paulo",
  state = "SP",
  street = "Rua Test",
  number = "123",
  district = "Centro",
  postCode = "01000000",
  affiliate = "",
}) {
  return {
    curso: tag,
    id_turma: Number(idTurma),
    full_name: fullName || email.split("@")[0],
    email,
    phone_number: phone,
    birth_date: birthDate,
    document_number: cpf,
    instituicao_financeira: financialInstitution,
    another_financial_instituition: "",
    city,
    state,
    street,
    number,
    district,
    post_code: postCode,
    type: "free",
    expiry: "",
    cupom: "",
    card: "",
    installments: 1,
    afiliado: affiliate,
    complement: "",
    contract: false,
    contractPrivacity: false,
    detailsCupom: "",
    selectedModules: [],
  };
}

function turmaSortValue(turma) {
  const date = Date.parse(`${String(turma.data_inicio ?? turma.data_inicio_aulas ?? "").slice(0, 10)}T00:00:00Z`);
  return [Number.isFinite(date) ? date : 0, Number(turma.id_turma ?? 0)];
}

function compareTurmaDesc(a, b) {
  const [aDate, aId] = turmaSortValue(a);
  const [bDate, bId] = turmaSortValue(b);
  if (aDate !== bDate) return bDate - aDate;
  return bId - aId;
}

// Motor de matrícula na plataforma ART. Recebe um cliente ART configurado e devolve
// as operações de alto nível usadas pela fila de processamento.
export function createEnrollmentService(artClient, config = {}) {
  const carrierUserIds = Array.isArray(config.carrierUserIds) && config.carrierUserIds.length
    ? config.carrierUserIds.map((value) => String(value).trim()).filter(Boolean)
    : ["204112", "204186", "204290", "204215"];
  const probeTag = String(config.carrierProbeTag ?? "cpa2026");
  const probeTurma = Number(config.carrierProbeTurma ?? 4058);
  const provisionTimeoutMs = Number(config.provisionTimeoutMs ?? 120_000);
  const defaultPhone = config.defaultPhone ?? "11999999999";
  const defaultBirthDate = config.defaultBirthDate ?? "1990-01-01";

  async function discoverCarrierToken(xApiKey) {
    for (const userId of carrierUserIds) {
      const token = forgeTransportJwt(userId);
      const { status, body } = await artClient.prepareCheckout({ tag: probeTag, idTurma: probeTurma, xApiKey, token });
      if (status === 200 && body?.course) return token;
    }
    throw new Error("nenhum carrier conhecido respondeu prepare 200; configure ART_CARRIER_USER_IDS");
  }

  // Lista todas as turmas ativas de uma tag via /v1/services/turmas. Esse endpoint
  // foi patcheado pela plataforma: REJEITA o carrier alg=none (401) e exige um
  // token RS256 real de login (ver pesquisa CURSOS-BANCARIOS, art_catalog_full.py).
  // Por isso recebe o token RS256 da conta do comprador, obtido apos o login.
  async function listActiveTurmasForTag({ tag, xApiKey, token, onLog = () => {} }) {
    const turmas = await artClient.listAllTurmas({ xApiKey, token, onLog });
    return turmas
      .filter((turma) => turma?.ativa === 1 && String(turma?.tag_curso ?? "").trim() === tag)
      .sort(compareTurmaDesc);
  }

  // Filtro oficial de checkout: uma turma so serve se prepareCheckout responder
  // 200 com course (o carrier alg=none ainda e aceito aqui). Recebe candidatos
  // (id_turma) e devolve os validos ordenados desc, enriquecidos com o course.
  async function validateCandidatesViaPrepare({ tag, candidates, xApiKey, carrierToken }) {
    const ordered = [...candidates].sort(compareTurmaDesc);
    const valid = [];
    for (const turma of ordered) {
      const idTurma = Number(turma.id_turma);
      const { status, body } = await artClient.prepareCheckout({ tag, idTurma, xApiKey, token: carrierToken });
      if (status === 200 && body?.course) {
        valid.push({
          idTurma,
          course: body.course,
          requiresFinancialInstitution: Boolean(body.financialInstitions),
          dataInicio: turma.data_inicio ?? turma.data_inicio_aulas ?? body.course.data_inicio ?? "",
        });
      }
    }
    return valid;
  }

  function pickVigente(valid) {
    const chosen = valid.length >= 2 ? valid[1] : valid[0];
    const reason = valid.length >= 2 ? "penultima-vigente" : "turma-unica";
    return { ...chosen, selectionReason: reason, allValid: valid };
  }

  // Resolve a turma de PROVISIONAMENTO (roda antes do login, sem RS256). Usa os
  // candidatos fornecidos (cohort do catalogo / job) e valida via prepare.
  async function resolveTurma({ tag, candidateTurmas, xApiKey, carrierToken, onLog = () => {} }) {
    if (!candidateTurmas?.length) {
      throw new Error(`sem candidatos para tag=${tag}; catalogo sem cohort ou job sem cohort`);
    }
    const candidates = candidateTurmas.map((idTurma) => ({ id_turma: Number(idTurma) }));
    const valid = await validateCandidatesViaPrepare({ tag, candidates, xApiKey, carrierToken });
    if (!valid.length) throw new Error(`nenhuma turma com checkout ativo para tag=${tag}`);
    const chosen = pickVigente(valid);
    onLog(`[turma] provisao ${chosen.selectionReason}: ${chosen.idTurma} (ultima=${valid[0].idTurma}, total_ativas=${valid.length}, inicio=${chosen.dataInicio})`);
    return chosen;
  }

  // Descoberta DINAMICA e autentica: com o RS256 real do comprador, lista as
  // turmas da tag em tempo real e valida via prepare. Mantem a turma de
  // provisionamento se ela continuar ativa (consistencia com a order PENDING ja
  // criada na fase 1); so troca se ela tiver saido do ar, usando a vigente real.
  async function refineTurmaDinamica({ tag, turmaProvisao, xApiKey, carrierToken, rs256, onLog = () => {} }) {
    let ativas;
    try {
      ativas = await listActiveTurmasForTag({ tag, xApiKey, token: rs256, onLog });
    } catch (error) {
      onLog(`[turma] descoberta dinamica indisponivel (${String(error).slice(0, 120)}); mantendo provisao ${turmaProvisao.idTurma}`);
      return turmaProvisao;
    }
    if (!ativas.length) {
      onLog(`[turma] dinamica: nenhuma turma ativa listada para tag=${tag}; mantendo provisao ${turmaProvisao.idTurma}`);
      return turmaProvisao;
    }
    const valid = await validateCandidatesViaPrepare({ tag, candidates: ativas, xApiKey, carrierToken });
    if (!valid.length) {
      onLog(`[turma] dinamica: turmas listadas mas nenhuma com checkout ativo; mantendo provisao ${turmaProvisao.idTurma}`);
      return turmaProvisao;
    }
    const aindaAtiva = valid.find((v) => v.idTurma === turmaProvisao.idTurma);
    if (aindaAtiva) {
      onLog(`[turma] dinamica confirmou provisao ${turmaProvisao.idTurma} (total_ativas=${valid.length}, ultima=${valid[0].idTurma})`);
      return { ...turmaProvisao, allValid: valid };
    }
    const chosen = pickVigente(valid);
    onLog(`[turma] dinamica TROCOU provisao ${turmaProvisao.idTurma} -> ${chosen.idTurma} (${chosen.selectionReason}, total_ativas=${valid.length})`);
    return chosen;
  }

  async function enrollStudent({ email, cpf, tag, fullName, financialInstitution = "", affiliate = "", candidateTurmas = null, onLog = () => {} }) {
    const xApiKey = generateXApiKey();
    const carrierToken = await discoverCarrierToken(xApiKey);
    const provisionCandidates = candidateTurmas ?? (getCohortBySourceTag(tag) ? [getCohortBySourceTag(tag)] : null);
    const turmaProvisao = await resolveTurma({ tag, candidateTurmas: provisionCandidates, xApiKey, carrierToken, onLog });

    const payloadDefaults = { phone: defaultPhone, birthDate: defaultBirthDate };
    let session = null;
    try {
      session = await artClient.login(email, cpf);
      onLog(`[enroll] conta existente user_id=${session.userId}`);
    } catch {
      onLog("[enroll] conta inexistente -> fase 1: provisionamento via carrier");
      const fiProvisao = financialInstitution || (turmaProvisao.requiresFinancialInstitution ? "998" : "");
      const payload = buildEnrollPayload({ tag, idTurma: turmaProvisao.idTurma, email, fullName, cpf, financialInstitution: fiProvisao, affiliate, ...payloadDefaults });
      const phase1 = await artClient.startCheckoutProcess({ payload, xApiKey, token: carrierToken });
      onLog(`[enroll] fase1 HTTP ${phase1.status} (500/400 podem ser normais no provisionamento)`);
      const deadline = Date.now() + provisionTimeoutMs;
      while (Date.now() < deadline && !session) {
        await sleep(5000);
        try { session = await artClient.login(email, cpf); } catch { session = null; }
      }
      if (!session) throw new Error("conta nao provisionou em 120s");
      onLog(`[enroll] conta provisionada user_id=${session.userId}`);
    }

    // Com o RS256 real do comprador, confirma/ajusta a turma dinamicamente.
    const turma = await refineTurmaDinamica({ tag, turmaProvisao, xApiKey, carrierToken, rs256: session.token, onLog });
    const idTurma = turma.idTurma;
    const resolvedFinancialInstitution = financialInstitution || (turma.requiresFinancialInstitution ? "998" : "");
    onLog(`[enroll] inicio email=${email} tag=${tag} turma=${idTurma} (${turma.selectionReason}) fi=${resolvedFinancialInstitution || "-"}`);

    await artClient.syncStudentProfile({ xApiKey, token: session.token });
    await sleep(2000);

    const payload = buildEnrollPayload({ tag, idTurma, email, fullName, cpf, financialInstitution: resolvedFinancialInstitution, affiliate, ...payloadDefaults });
    const phase2 = await artClient.startCheckoutProcess({ payload, xApiKey, token: session.token });
    onLog(`[enroll] fase2 HTTP ${phase2.status}: ${String(phase2.text ?? "").slice(0, 180)}`);

    const pending = phase2.status === 400 || phase2.status === 500;
    const wait = await artClient.waitForEnrollment({
      tag,
      email,
      xApiKey,
      token: session.token,
      onProbe: ({ probe, status, courseCount }) => onLog(`[enroll] probe ${probe} HTTP ${status} cursos=${courseCount ?? "?"}`),
    });

    if (!wait.enrollment) {
      return { status: pending ? "PENDING" : "NOT_CREATED", userId: session.userId, idTurma, turmaSelection: turma.selectionReason, phase2Http: phase2.status, phase2Body: phase2.body };
    }
    return { status: "CONFIRMED", userId: session.userId, idTurma, turmaSelection: turma.selectionReason, enrollment: wait.enrollment, phase2Http: phase2.status };
  }

  async function listStudentCourses({ email, cpf }) {
    const xApiKey = generateXApiKey();
    const session = await artClient.login(email, cpf);
    const { status, body } = await artClient.findCoursesByStudent({ email, xApiKey, token: session.token });
    if (status !== 200 || !Array.isArray(body)) {
      throw new Error(`findCoursesByStudent HTTP ${status}: ${String(body).slice(0, 300)}`);
    }
    return body;
  }

  return Object.freeze({ enrollStudent, listStudentCourses, resolveTurma, listActiveTurmasForTag, discoverCarrierToken });
}
