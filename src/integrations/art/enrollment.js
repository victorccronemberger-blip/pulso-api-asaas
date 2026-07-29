import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { encryptCard, generateXApiKey } from "./credentials.js";
import { getCohortBySourceTag } from "../../domain/catalog.js";

// Cartão vazio no formato exato da SPA de checkout (ordem de chaves incluída).
// É cifrado com a chave pública da ART e enviado mesmo em matrícula gratuita —
// faz parte do payload FIEL que a plataforma aceita sem crashar.
const EMPTY_CARD = Object.freeze({
  type: "",
  brand: "",
  card_number: "",
  expiration_month: "",
  expiration_year: "",
  holder_document: "",
  holder_name: "",
  security_code: "",
});

// Payload FIEL ao onFinish da SPA de checkout da ART. A pesquisa validou que
// payloads "pobres" (card:"", detailsCupom:"") crasham o provisionamento ANTES
// de criar a conta; este formato (cartão cifrado, detailsCupom objeto,
// getnet_fingerprint, promo_opt_in, contract:true) provisiona de forma confiável
// e permite o fluxo inteiro SEM nenhum token alg=none — a fase 1 roda só com
// x-api-key e a conta nasce com senha = CPF do comprador.
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
    card: encryptCard(EMPTY_CARD),
    installments: 1,
    afiliado: affiliate,
    complement,
    contract: true,
    contractPrivacity: true,
    promo_opt_in: false,
    detailsCupom: { valid: false, cashValue: 0, value: 0 },
    selectedModules: [],
    getnet_fingerprint: randomBytes(16).toString("hex"),
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

// Motor de matrícula na plataforma ART. Fluxo real validado (pesquisa
// CURSOS-BANCARIOS, 2026-07-29), sem nenhum token alg=none:
//   fase 1 — process/start só com x-api-key + payload fiel → provisiona a conta
//            (senha = CPF) e cria a order type=free;
//   login  — email + CPF → JWT RS256 REAL do comprador;
//   fase 2 — process/start com o RS256 (sub == user_id do email) → efetiva;
//   polling — findCoursesByStudent (RS256) até a matrícula aparecer.
export function createEnrollmentService(artClient, config = {}) {
  const provisionTimeoutMs = Number(config.provisionTimeoutMs ?? 120_000);
  const defaultPhone = config.defaultPhone ?? "11999999999";
  const defaultBirthDate = config.defaultBirthDate ?? "1990-01-01";
  const serviceAccounts = Array.isArray(config.serviceAccounts)
    ? config.serviceAccounts.filter((account) => account?.email && account?.password)
    : [];
  const store = config.store ?? null;

  // Lista todas as turmas ativas de uma tag via /v1/services/turmas. Esse endpoint
  // exige um token RS256 real de login (a plataforma rejeita tokens de transporte),
  // por isso recebe o RS256 da conta do comprador ou de uma service-account.
  async function listActiveTurmasForTag({ tag, xApiKey, token, onLog = () => {} }) {
    const turmas = await artClient.listAllTurmas({ xApiKey, token, onLog });
    return turmas
      .filter((turma) => turma?.ativa === 1 && String(turma?.tag_curso ?? "").trim() === tag)
      .sort(compareTurmaDesc);
  }

  // Filtro oficial de checkout: uma turma só serve se prepareCheckout responder
  // 200 com course. O prepare roda SÓ com x-api-key (sem Bearer) — não precisa de
  // nenhum token de usuário, muito menos alg=none.
  async function validateCandidatesViaPrepare({ tag, candidates, xApiKey }) {
    const ordered = [...candidates].sort(compareTurmaDesc);
    const valid = [];
    for (const turma of ordered) {
      const idTurma = Number(turma.id_turma);
      const { status, body } = await artClient.prepareCheckout({ tag, idTurma, xApiKey });
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

  // Regra de negócio do contrato ART (Rafael, 2026-07-29): matricular na turma
  // MAIS RECENTE com checkout ativo. `valid` já chega ordenada desc — valid[0].
  function pickVigente(valid) {
    const chosen = valid[0];
    return { ...chosen, selectionReason: valid.length >= 2 ? "turma-mais-recente" : "turma-unica", allValid: valid };
  }

  // Varredura de ids via prepare (só x-api-key). Recebe faixas [inicio, fim]
  // explícitas — quem decide as faixas é o discoverTurmasVivas (âncoras +
  // fronteira persistida).
  async function scanTurmasViaPrepare({ tag, xApiKey, ranges, onLog = () => {} }) {
    const ids = new Set();
    for (const range of ranges ?? []) {
      const start = Math.max(1, Math.floor(Number(range?.[0])));
      const end = Math.min(Math.floor(Number(range?.[1])), start + 400);
      for (let idTurma = start; idTurma <= end; idTurma += 1) ids.add(idTurma);
    }
    const candidates = [...ids];
    if (!candidates.length) return [];
    onLog(`[turma] scan prepare: ${candidates.length} candidatos para tag=${tag}`);
    const valid = [];
    const concurrency = 12;
    for (let start = 0; start < candidates.length; start += concurrency) {
      const batch = candidates.slice(start, start + concurrency);
      const results = await Promise.all(batch.map(async (idTurma) => {
        try {
          const { status, body } = await artClient.prepareCheckout({ tag, idTurma, xApiKey });
          if (status === 200 && body?.course) {
            return { idTurma, course: body.course, requiresFinancialInstitution: Boolean(body.financialInstitions), data_inicio: body.course.data_inicio ?? "" };
          }
        } catch { /* candidato fora do ar — segue o scan */ }
        return null;
      }));
      for (const result of results) if (result) valid.push(result);
    }
    valid.sort(compareTurmaDesc);
    if (valid.length) onLog(`[turma] scan prepare achou ${valid.length} turma(s) ativa(s): ${valid.map((v) => v.idTurma).join(", ")}`);
    return valid;
  }

  // Descoberta de turmas vivas SEM o login do comprador — mantém o projeto
  // funcionando quando o cohort do catálogo morre ou a plataforma lança turma
  // nova. Camadas, da mais dinâmica para a mais bruta:
  //   1. SERVICE ACCOUNTS (ART_SERVICE_ACCOUNTS): login dedicado → RS256 real →
  //      listagem de /v1/services/turmas → filtro por tag → validação via prepare.
  //   2. SCAN ADAPTATIVO via prepare (só x-api-key): âncoras (cohorts) ±150 +
  //      fronteira PERSISTIDA por tag (app_settings). Quando acha turma na borda,
  //      estende e grava — a próxima execução já cobre o território novo.
  async function discoverTurmasVivas({ tag, xApiKey, anchors, onLog = () => {} }) {
    for (const account of serviceAccounts) {
      try {
        const session = await artClient.login(account.email, account.password);
        const ativas = await listActiveTurmasForTag({ tag, xApiKey, token: session.token, onLog });
        if (!ativas.length) {
          onLog(`[turma] service-account ${account.email}: nenhuma turma ativa listada para tag=${tag}`);
          continue;
        }
        const valid = await validateCandidatesViaPrepare({ tag, candidates: ativas, xApiKey });
        if (valid.length) {
          onLog(`[turma] service-account ${account.email}: ${valid.length} turma(s) viva(s) em tempo real: ${valid.map((v) => v.idTurma).join(", ")}`);
          return valid;
        }
        onLog(`[turma] service-account ${account.email}: turmas listadas mas nenhuma com checkout ativo`);
      } catch (error) {
        onLog(`[turma] service-account ${account.email} indisponivel (${String(error).slice(0, 100)})`);
      }
    }
    const numericAnchors = (anchors ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    let frontier = null;
    if (store?.getSetting) {
      try { frontier = Number(await store.getSetting(`art-scan-frontier:${tag}`)) || null; } catch { frontier = null; }
    }
    const ranges = numericAnchors.map((anchor) => [anchor - 150, anchor + 150]);
    const frontierStart = frontier ?? (numericAnchors.length ? Math.max(...numericAnchors) + 151 : 4130);
    ranges.push([frontierStart, frontierStart + 250]);
    const valid = await scanTurmasViaPrepare({ tag, xApiKey, ranges, onLog });
    if (valid.length && store?.setSetting) {
      const maxFound = Math.max(...valid.map((v) => v.idTurma));
      const nextFrontier = Math.max(maxFound + 100, frontierStart + 250);
      if (nextFrontier !== frontier) {
        try {
          await store.setSetting(`art-scan-frontier:${tag}`, nextFrontier);
          onLog(`[turma] fronteira de scan persistida: ${nextFrontier}`);
        } catch { /* melhor esforço */ }
      }
    }
    return valid;
  }

  // Resolve a turma de PROVISIONAMENTO (roda antes do login, sem RS256). Usa os
  // candidatos fornecidos (cohort do catálogo / job) e valida via prepare.
  async function resolveTurma({ tag, candidateTurmas, xApiKey, onLog = () => {} }) {
    if (!candidateTurmas?.length) {
      throw new Error(`sem candidatos para tag=${tag}; catalogo sem cohort ou job sem cohort`);
    }
    const candidates = candidateTurmas.map((idTurma) => ({ id_turma: Number(idTurma) }));
    const valid = await validateCandidatesViaPrepare({ tag, candidates, xApiKey });
    if (!valid.length) throw new Error(`nenhuma turma com checkout ativo para tag=${tag}`);
    const chosen = pickVigente(valid);
    onLog(`[turma] provisao ${chosen.selectionReason}: ${chosen.idTurma} (ultima=${valid[0].idTurma}, total_ativas=${valid.length}, inicio=${chosen.dataInicio})`);
    return chosen;
  }

  // Descoberta DINÂMICA e autêntica: com o RS256 real do comprador, lista as
  // turmas da tag em tempo real e valida via prepare. Mantém a turma de
  // provisionamento se ela continuar ativa (consistência com a order PENDING já
  // criada na fase 1); só troca se ela tiver saído do ar, usando a vigente real.
  async function refineTurmaDinamica({ tag, turmaProvisao, xApiKey, rs256, onLog = () => {} }) {
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
    const valid = await validateCandidatesViaPrepare({ tag, candidates: ativas, xApiKey });
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
  // quando o perfil da plataforma está vazio — nunca "Rua Test"/"11999999999"
  // poluindo o cadastro de um cliente real.
  // Orders PENDING ficam invisíveis no findCoursesByStudent — a resposta do
  // findOrdersByStudent tem formato imprevisível (dict aninhado ou lista), então
  // a varredura é profunda e defensiva.
  function collectPendingOrders(value, out = []) {
    if (!value || typeof value !== "object") return out;
    if (Array.isArray(value)) {
      for (const item of value) collectPendingOrders(item, out);
      return out;
    }
    if (value.id_order && String(value.status ?? "").toUpperCase() === "PENDING") out.push(value);
    for (const item of Object.values(value)) collectPendingOrders(item, out);
    return out;
  }

  // Só deleta order que casa FORTEMENTE com a tag/turma do job (id_turma igual
  // ou tag explícita igual). Ambiguidade => não toca em nada (nunca apagar a
  // order PENDING de OUTRO curso do mesmo aluno). Máximo 3 por segurança.
  async function recoverStuckPendingOrder({ tag, idTurma, email, idUsuario, payload, xApiKey, getToken, relogin, onLog }) {
    if (!idUsuario) return null;
    let listed;
    try {
      listed = await artClient.findOrdersByStudent({ idUsuario, xApiKey, token: getToken() });
    } catch {
      return null;
    }
    if (listed.status !== 200) {
      onLog(`[enroll] recovery: findOrdersByStudent HTTP ${listed.status} — sem caminho de delete`);
      return null;
    }
    const pendingOrders = collectPendingOrders(listed.body);
    const tagLower = tag.toLowerCase();
    const matches = pendingOrders.filter((order) => {
      if (order.id_turma && Number(order.id_turma) === Number(idTurma)) return true;
      const orderTag = String(order.tag ?? order.tag_curso ?? order.curso ?? "").toLowerCase();
      return orderTag === tagLower;
    });
    if (!matches.length) {
      onLog(`[enroll] recovery: ${pendingOrders.length} order(s) PENDING, nenhuma da tag/turma — sem delete`);
      return null;
    }
    if (matches.length > 3) {
      onLog(`[enroll] recovery: ${matches.length} orders PENDING ambiguas para tag=${tag} — abortando delete por seguranca`);
      return null;
    }
    let deletedOrderId = null;
    for (const order of matches.slice(0, 3)) {
      try {
        const deleted = await artClient.deleteOrder({ idOrder: order.id_order, xApiKey, token: getToken() });
        onLog(`[enroll] recovery: DELETE order ${order.id_order} -> HTTP ${deleted.status} ${String(deleted.text ?? "").slice(0, 40)}`);
        if (deleted.status === 200 && String(deleted.text ?? "").trim() === "1") deletedOrderId = order.id_order;
      } catch (error) {
        onLog(`[enroll] recovery: delete da order ${order.id_order} falhou (${String(error).slice(0, 80)})`);
      }
    }
    if (!deletedOrderId) return null;
    const phase3 = await artClient.startCheckoutProcess({ payload, xApiKey, token: getToken() });
    onLog(`[enroll] recovery: re-enroll limpo HTTP ${phase3.status}: ${String(phase3.text ?? "").slice(0, 160)}`);
    const wait = await artClient.waitForEnrollment({
      tag,
      email,
      xApiKey,
      token: getToken(),
      onProbe: ({ probe, status, courseCount }) => onLog(`[enroll] recovery probe ${probe} HTTP ${status} cursos=${courseCount ?? "?"}`),
      onUnauthorized: relogin,
      onProfileMissing: async () => { await artClient.syncStudentProfile({ xApiKey, token: getToken() }); },
    });
    if (!wait.enrollment) return null;
    return { enrollment: wait.enrollment, deletedOrderId };
  }

  async function enrollStudent({ email, cpf, tag, fullName, phone = null, birthDate = null, address = null, financialInstitution = "", affiliate = "", candidateTurmas = null, onLog = () => {} }) {
    const xApiKey = generateXApiKey();
    const provisionCandidates = candidateTurmas ?? (getCohortBySourceTag(tag) ? [getCohortBySourceTag(tag)] : null);

    const payloadDefaults = { phone: defaultPhone, birthDate: defaultBirthDate };
    const buyerData = {
      phone: phone || null,
      birthDate: birthDate || null,
      ...(address ?? {}),
    };

    // Fast path: cohort do catálogo validado via prepare (só x-api-key). Se o
    // cohort do catálogo está morto (checkout fechado), NÃO desiste: descobre as
    // turmas vivas (service-account RS256 / scan adaptativo via prepare).
    let turmaProvisao = null;
    try {
      turmaProvisao = await resolveTurma({ tag, candidateTurmas: provisionCandidates, xApiKey, onLog });
    } catch (error) {
      onLog(`[turma] catalogo sem turma ativa (${String(error).slice(0, 120)}) — descoberta dinamica (service-account/scan adaptativo)`);
      const discovered = await discoverTurmasVivas({ tag, xApiKey, anchors: provisionCandidates, onLog });
      if (discovered.length) {
        turmaProvisao = pickVigente(discovered);
        onLog(`[turma] descoberta dinamica resolveu provisao ${turmaProvisao.idTurma} (${turmaProvisao.selectionReason})`);
      }
    }

    let session = null;
    try {
      session = await artClient.login(email, cpf);
      onLog(`[enroll] conta existente user_id=${session.userId}`);
    } catch {
      if (!turmaProvisao) {
        // Conta nova + catálogo morto: sem login não há RS256 para listar turmas.
        onLog("[enroll] conta inexistente e catalogo sem turma ativa — descoberta RS256 impossivel sem login");
        throw new Error(`catalogo sem turma ativa para tag=${tag} e conta nova (sem RS256 para descoberta dinamica)`);
      }
      onLog("[enroll] conta inexistente -> fase 1: provisionamento (so x-api-key, payload fiel)");
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
      // FASE 1 — SEM Bearer: o provisionamento roda só com x-api-key quando o
      // payload é fiel à SPA. HTTP 500/400 aqui é esperado e ainda assim cria a
      // conta (senha = CPF) e a order type=free.
      const phase1 = await artClient.startCheckoutProcess({ payload, xApiKey });
      onLog(`[enroll] fase1 HTTP ${phase1.status} (500/400 podem ser normais no provisionamento)`);
      const deadline = Date.now() + provisionTimeoutMs;
      while (Date.now() < deadline && !session) {
        await sleep(5000);
        try { session = await artClient.login(email, cpf); } catch { session = null; }
      }
      if (!session) throw new Error("conta nao provisionou em 120s");
      onLog(`[enroll] conta provisionada user_id=${session.userId} (senha=CPF confirmada pelo login)`);
    }

    // Catálogo morto + conta existente: descoberta autêntica das turmas vivas
    // com o RS256 do comprador. Valida via prepare e escolhe a vigente.
    if (!turmaProvisao) {
      const ativas = await listActiveTurmasForTag({ tag, xApiKey, token: session.token, onLog });
      const valid = await validateCandidatesViaPrepare({ tag, candidates: ativas, xApiKey });
      if (!valid.length) throw new Error(`nenhuma turma com checkout ativo para tag=${tag} mesmo via descoberta RS256`);
      turmaProvisao = pickVigente(valid);
      onLog(`[turma] descoberta-RS256 resolveu provisao ${turmaProvisao.idTurma} (fallback de catalogo morto, ultima=${valid[0].idTurma}, total=${valid.length})`);
    }

    // Com o RS256 real do comprador, confirma/ajusta a turma dinamicamente.
    const turma = await refineTurmaDinamica({ tag, turmaProvisao, xApiKey, rs256: session.token, onLog });
    const idTurma = turma.idTurma;
    const resolvedFinancialInstitution = financialInstitution || (turma.requiresFinancialInstitution ? "998" : "");
    onLog(`[enroll] inicio email=${email} tag=${tag} turma=${idTurma} (${turma.selectionReason}) fi=${resolvedFinancialInstitution || "-"}`);

    // Identidade alinhada ao perfil JÁ REGISTRADO na plataforma: o documento do
    // aluno manda no payload. Caso real (produção, 2026-07-29): conta criada com
    // um CPF e pedido posterior com outro -> fase2 respondia 500 "Ops" até o
    // payload bater com o documento do perfil. O CPF do pedido só vale quando a
    // conta acabou de ser provisionada por nós (fase 1, sem perfil anterior).
    const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "") || null;
    let platformProfile = null;
    try {
      const found = await artClient.findStudent({ email, xApiKey, token: session.token });
      if (found.status === 200 && found.body && typeof found.body === "object") platformProfile = found.body;
    } catch { /* sonda tolerante: segue com os dados do pedido */ }
    const platformDocument = digitsOnly(platformProfile?.documento);
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
    // FASE 2 — com o RS256 real do comprador (sub == user_id do email): efetiva
    // a order. HTTP 400 "pagamento sendo processado" = order PENDING já existe.
    const phase2 = await artClient.startCheckoutProcess({ payload, xApiKey, token: session.token });
    onLog(`[enroll] fase2 HTTP ${phase2.status}: ${String(phase2.text ?? "").slice(0, 180)}`);

    const pending = phase2.status === 400 || phase2.status === 500;
    // Se outra sessão da mesma conta logar (instância concorrente, operador na
    // plataforma), a nossa morre (401). Renova aqui dentro da MESMA tentativa.
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
    const resyncProfile = async () => {
      onLog("[enroll] perfil do aluno ausente (500 id_usuario) — re-sincronizando via student/metrics");
      await artClient.syncStudentProfile({ xApiKey, token: session.token });
    };
    const wait = await artClient.waitForEnrollment({
      tag,
      email,
      xApiKey,
      token: session.token,
      onProbe: ({ probe, status, courseCount, relogin: relogging, profileResync }) => onLog(`[enroll] probe ${probe} HTTP ${status} cursos=${courseCount ?? "?"}${relogging ? " (401 -> renovando sessao)" : ""}${profileResync ? " (perfil ausente -> re-sync)" : ""}`),
      onUnauthorized: relogin,
      onProfileMissing: resyncProfile,
    });

    if (!wait.enrollment) {
      // Order PENDING zumbi: invisível no findCoursesByStudent, bloqueia re-enroll
      // (400) e espera um flip assíncrono que pode nunca vir. Caminho determinístico
      // validado na pesquisa: achar a order PENDING da tag/turma via
      // findOrdersByStudent, DELETAR e re-enviar o enroll limpo — a nova order
      // type=free nasce APPROVED na hora.
      const recovery = await recoverStuckPendingOrder({
        tag,
        idTurma,
        email,
        idUsuario: platformProfile?.id_usuario ?? session.raw?.id_usuario ?? null,
        payload,
        xApiKey,
        getToken: () => session.token,
        relogin,
        onLog,
      });
      if (!recovery) {
        return { status: pending ? "PENDING" : "NOT_CREATED", userId: session.userId, idTurma, turmaSelection: turma.selectionReason, phase2Http: phase2.status, phase2Body: phase2.body };
      }
      return { status: "CONFIRMED", userId: session.userId, idTurma, turmaSelection: turma.selectionReason, enrollment: recovery.enrollment, recoveredOrderId: recovery.deletedOrderId, phase2Http: phase2.status };
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

  return Object.freeze({ enrollStudent, listStudentCourses, resolveTurma, listActiveTurmasForTag });
}
