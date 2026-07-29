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
  complement = "",
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
    complement,
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

  // Regra de negócio do contrato ART (atualizada em 2026-07-29 pelo Rafael):
  // matricular na turma MAIS RECENTE com checkout ativo. A lista `valid` já
  // chega ordenada desc (data de início, depois id) — valid[0] é a mais nova.
  function pickVigente(valid) {
    const chosen = valid[0];
    return { ...chosen, selectionReason: valid.length >= 2 ? "turma-mais-recente" : "turma-unica", allValid: valid };
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

  // phone/birthDate/address vêm do pedido PULSO (coletados no checkout). Entram
  // no payload quando a conta é provisionada por nós (fase 1) e como fallback
  // quando o perfil da plataforma está vazio — nunca mais "Rua Test"/"11999999999"
  // poluindo o cadastro de um cliente real.
  async function enrollStudent({ email, cpf, tag, fullName, phone = null, birthDate = null, address = null, financialInstitution = "", affiliate = "", candidateTurmas = null, onLog = () => {} }) {
    const xApiKey = generateXApiKey();
    const carrierToken = await discoverCarrierToken(xApiKey);
    const provisionCandidates = candidateTurmas ?? (getCohortBySourceTag(tag) ? [getCohortBySourceTag(tag)] : null);

    const payloadDefaults = { phone: defaultPhone, birthDate: defaultBirthDate };
    const buyerData = {
      phone: phone || null,
      birthDate: birthDate || null,
      ...(address ?? {}),
    };

    // Fast path: cohort do catálogo validado via prepare com o carrier.
    // Se o cohort do catálogo está morto (checkout fechado — caso cfp_modular
    // 3629 em produção, 2026-07-29), NÃO desiste: loga primeiro e descobre as
    // turmas vivas com o RS256 da conta do comprador.
    let turmaProvisao = null;
    try {
      turmaProvisao = await resolveTurma({ tag, candidateTurmas: provisionCandidates, xApiKey, carrierToken, onLog });
    } catch (error) {
      onLog(`[turma] catalogo sem turma ativa (${String(error).slice(0, 120)}) — tentando descoberta com login RS256`);
    }

    let session = null;
    try {
      session = await artClient.login(email, cpf);
      onLog(`[enroll] conta existente user_id=${session.userId}`);
    } catch {
      if (!turmaProvisao) {
        // Conta nova + catálogo morto: sem login não há RS256 para listar turmas.
        // O único caminho seria o catálogo — falha clara em vez de seguir sem turma.
        onLog("[enroll] conta inexistente e catalogo sem turma ativa — descoberta RS256 impossivel sem login");
        throw new Error(`catalogo sem turma ativa para tag=${tag} e conta nova (sem RS256 para descoberta dinamica)`);
      }
      onLog("[enroll] conta inexistente -> fase 1: provisionamento via carrier");
      const fiProvisao = financialInstitution || (turmaProvisao.requiresFinancialInstitution ? "998" : "");
      const payload = buildEnrollPayload({
        tag,
        idTurma: turmaProvisao.idTurma,
        email,
        fullName,
        cpf,
        financialInstitution: fiProvisao,
        affiliate,
        phone: buyerData.phone ?? payloadDefaults.phone,
        birthDate: buyerData.birthDate ?? payloadDefaults.birthDate,
        ...(buyerData.city || buyerData.postCode ? {
          city: buyerData.city ?? "Sao Paulo",
          state: buyerData.state ?? "SP",
          street: buyerData.street ?? "Rua Test",
          number: buyerData.number ?? "123",
          district: buyerData.district ?? "Centro",
          postCode: buyerData.postCode ?? "01000000",
        } : {}),
      });
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

    // Catálogo morto + conta existente: descoberta autenticada das turmas vivas
    // com o RS256 do comprador (o carrier alg=none não lista /services/turmas
    // desde o patch da plataforma). Valida via prepare e escolhe a vigente.
    if (!turmaProvisao) {
      const ativas = await listActiveTurmasForTag({ tag, xApiKey, token: session.token, onLog });
      const valid = await validateCandidatesViaPrepare({ tag, candidates: ativas, xApiKey, carrierToken });
      if (!valid.length) throw new Error(`nenhuma turma com checkout ativo para tag=${tag} mesmo via descoberta RS256`);
      turmaProvisao = pickVigente(valid);
      onLog(`[turma] descoberta-RS256 resolveu provisao ${turmaProvisao.idTurma} (fallback de catalogo morto, ultima=${valid[0].idTurma}, total=${valid.length})`);
    }

    // Com o RS256 real do comprador, confirma/ajusta a turma dinamicamente.
    const turma = await refineTurmaDinamica({ tag, turmaProvisao, xApiKey, carrierToken, rs256: session.token, onLog });
    const idTurma = turma.idTurma;
    const resolvedFinancialInstitution = financialInstitution || (turma.requiresFinancialInstitution ? "998" : "");
    onLog(`[enroll] inicio email=${email} tag=${tag} turma=${idTurma} (${turma.selectionReason}) fi=${resolvedFinancialInstitution || "-"}`);

    // Identidade alinhada ao perfil JA REGISTRADO na plataforma: o documento do
    // aluno manda no payload. Caso real (producao, 2026-07-29): conta criada com
    // um CPF e pedido posterior com outro -> fase2 respondia 500 "Ops" ate o
    // payload bater com o documento do perfil. O CPF do pedido so vale quando a
    // conta acabou de ser provisionada por nos (fase 1, sem perfil anterior).
    const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "") || null;
    let platformProfile = null;
    try {
      const found = await artClient.findStudent({ email, xApiKey, token: session.token });
      if (found.status === 200 && found.body && typeof found.body === "object") platformProfile = found.body;
    } catch { /* sonda tolerante: segue com os dados do pedido */ }
    const platformDocument = digitsOnly(platformProfile?.documento);
    // Prioridade de cada variável: perfil da plataforma > dados do pedido PULSO
    // > defaults de pesquisa. Garante que cliente novo nasce com dados reais e
    // cliente antigo não colide com o que já está registrado na plataforma.
    const identity = {
      cpf: platformDocument ?? cpf,
      fullName: [platformProfile?.nome, platformProfile?.sobre_nome].filter(Boolean).join(" ").trim() || fullName,
      phone: digitsOnly(platformProfile?.telefone) ?? buyerData.phone ?? defaultPhone,
      birthDate: String(platformProfile?.dt_nascimento ?? "").slice(0, 10) || buyerData.birthDate || defaultBirthDate,
      city: platformProfile?.cidade || buyerData.city || "Sao Paulo",
      state: platformProfile?.uf || buyerData.state || "SP",
      street: platformProfile?.rua || buyerData.street || "Rua Test",
      number: String(platformProfile?.numero ?? "").trim() || buyerData.number || "123",
      district: platformProfile?.bairro || buyerData.district || "Centro",
      postCode: digitsOnly(platformProfile?.cep) ?? buyerData.postCode ?? "01000000",
      complement: String(platformProfile?.complement ?? "").trim() || buyerData.complement || "",
    };
    if (platformDocument && platformDocument !== cpf) {
      onLog(`[enroll] perfil da plataforma tem doc ...${platformDocument.slice(-4)} DIFERENTE do pedido ...${String(cpf).slice(-4)} — usando o da plataforma`);
    }

    await artClient.syncStudentProfile({ xApiKey, token: session.token });
    await sleep(2000);

    const payload = buildEnrollPayload({
      tag,
      idTurma,
      email,
      fullName: identity.fullName,
      cpf: identity.cpf,
      phone: identity.phone,
      birthDate: identity.birthDate,
      financialInstitution: resolvedFinancialInstitution,
      city: identity.city,
      state: identity.state,
      street: identity.street,
      number: identity.number,
      district: identity.district,
      postCode: identity.postCode,
      complement: identity.complement,
      affiliate,
    });
    const phase2 = await artClient.startCheckoutProcess({ payload, xApiKey, token: session.token });
    onLog(`[enroll] fase2 HTTP ${phase2.status}: ${String(phase2.text ?? "").slice(0, 180)}`);

    const pending = phase2.status === 400 || phase2.status === 500;
    // Se outra sessão da mesma conta logar (instância concorrente, operador na
    // plataforma), a nossa morre (401). Renova aqui dentro da MESMA tentativa
    // em vez de derrubar o retry inteiro — re-login é barato, perder a ordem não.
    const relogin = async () => {
      try {
        session = await artClient.login(email, cpf);
        onLog(`[enroll] sessao renovada apos 401 (user_id=${session.userId})`);
        return session.token;
      } catch (error) {
        onLog(`[enroll] re-login apos 401 falhou: ${String(error).slice(0, 140)}`);
        return null;
      }
    };
    const wait = await artClient.waitForEnrollment({
      tag,
      email,
      xApiKey,
      token: session.token,
      onProbe: ({ probe, status, courseCount, relogin: relogging }) => onLog(`[enroll] probe ${probe} HTTP ${status} cursos=${courseCount ?? "?"}${relogging ? " (401 -> renovando sessao)" : ""}`),
      onUnauthorized: relogin,
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
