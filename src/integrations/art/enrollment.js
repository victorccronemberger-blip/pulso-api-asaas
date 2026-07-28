import { setTimeout as sleep } from "node:timers/promises";
import { forgeTransportJwt, generateXApiKey } from "./credentials.js";

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

  async function listActiveTurmasForTag({ tag, xApiKey, carrierToken, onLog = () => {} }) {
    const turmas = await artClient.listAllTurmas({ xApiKey, token: carrierToken, onLog });
    return turmas
      .filter((turma) => turma?.ativa === 1 && String(turma?.tag_curso ?? "").trim() === tag)
      .sort(compareTurmaDesc);
  }

  async function resolveTurma({ tag, candidateTurmas, xApiKey, carrierToken, onLog = () => {} }) {
    const candidates = candidateTurmas?.length
      ? candidateTurmas.map((idTurma) => ({ id_turma: Number(idTurma) }))
      : await listActiveTurmasForTag({ tag, xApiKey, carrierToken, onLog });
    const orderedCandidates = [...candidates].sort(compareTurmaDesc);
    const valid = [];
    for (const turma of orderedCandidates) {
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
    if (!valid.length) throw new Error(`nenhuma turma com checkout ativo para tag=${tag}`);
    const chosen = valid.length >= 2 ? valid[1] : valid[0];
    const reason = valid.length >= 2 ? "penultima-vigente" : "turma-unica";
    onLog(`[turma] ${reason}: ${chosen.idTurma} (ultima=${valid[0].idTurma}, total_ativas=${valid.length}, inicio=${chosen.dataInicio})`);
    return { ...chosen, selectionReason: reason, allValid: valid };
  }

  async function enrollStudent({ email, cpf, tag, fullName, financialInstitution = "", affiliate = "", onLog = () => {} }) {
    const xApiKey = generateXApiKey();
    const carrierToken = await discoverCarrierToken(xApiKey);
    const turma = await resolveTurma({ tag, xApiKey, carrierToken, onLog });
    const idTurma = turma.idTurma;
    const resolvedFinancialInstitution = financialInstitution || (turma.requiresFinancialInstitution ? "998" : "");
    onLog(`[enroll] inicio email=${email} tag=${tag} turma=${idTurma} (${turma.selectionReason})`);

    const payloadDefaults = { phone: defaultPhone, birthDate: defaultBirthDate };
    let session = null;
    try {
      session = await artClient.login(email, cpf);
      onLog(`[enroll] conta existente user_id=${session.userId}`);
    } catch {
      onLog("[enroll] conta inexistente -> fase 1: provisionamento via carrier");
      const payload = buildEnrollPayload({ tag, idTurma, email, fullName, cpf, financialInstitution: resolvedFinancialInstitution, affiliate, ...payloadDefaults });
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
