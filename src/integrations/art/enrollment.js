import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { encryptCard, generateXApiKey } from "./credentials.js";
import { getCohortBySourceTag, syncCohortBySourceTag } from "../../domain/catalog.js";

// ============================================================================
// MOTOR DE ATIVACAO AUTOMATICA — REESCRITA 2026-08-01
// ----------------------------------------------------------------------------
// Modelo validado na pesquisa (Metodos-Toro, 2026-08-01): 10/10 cursos ativados
// com email real na caixa. Este motor integra OS 5 VETORES em camadas
// determinísticas, 100% dinâmico (turma obtida AO VIVO, nunca confiada ao
// cohort gravado) e à prova de falhas (cada camada cobre o que a anterior não
// resolveu; nenhuma operação destrói dados sem necessidade).
//
//   FASE 0  PRE  — sessão + verificação de conta existente (não duplica conta,
//                  resolve CPF real da plataforma quando diverge do pedido)
//   FASE 1  TURMA— descoberta dinâmica em camadas:
//                  1) service-account (RS256 real) → /v1/services/turmas
//                  2) RS256 do comprador (conta existente)
//                  3) cohort do catálogo como HINT validado via prepare
//                  4) scan adaptativo por range (âncora + fronteira persistida)
//                  5) turmas de COMBO/derivadas (VETOR E)
//   FASE 2  PROV — conta nova: fase1 provisiona (senha=CPF) | conta existente:
//                  login com o CPF correto (da plataforma se divergir)
//   FASE 3  EFET — fase2 enroll + polling curto
//   FASE 4  REC  — recuperação em cascata:
//                  [C] flip POST /v1/crud/orders/{id} (DENIED→APPROVED)
//                  [D] id_turma swap para a turma que o APP aceita
//                  [E] turmas de combo alternativas
//                  [legado] DELETE + re-enroll (último recurso)
//   FASE 5  VER  — findCoursesByStudent → is_visible=true
//
// Nenhum token alg=none. Transporte: x-api-key RSA + JWT RS256 real do aluno.
// ============================================================================

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

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------
const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "") || null;

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

// Escolhe a turma que MAXIMIZA a chance de type=free aprovar (regra validada):
//   1. turma FREE mais recente (valor_curso===0) → job aprova imediato
//      (casos: ancord free XP-ART, CPA Santander bonus)
//   2. senão a PENÚLTIMA (a última é a vigente/paga → type=free fica PENDING;
//      a penúltima "já passou" → free, aprova)
//   3. senão a única disponível
function pickVigente(valid) {
  const free = valid.filter((v) => Number(v.course?.valor_curso) === 0);
  if (free.length) {
    return { ...free[0], selectionReason: "free-mais-recente", allValid: valid };
  }
  const chosen = valid.length >= 2 ? valid[1] : valid[0];
  return { ...chosen, selectionReason: valid.length >= 2 ? "penultima-turma" : "turma-unica", allValid: valid };
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------
export function createEnrollmentService(artClient, config = {}) {
  const provisionTimeoutMs = Number(config.provisionTimeoutMs ?? 120_000);
  const pollTimeoutMs = Number(config.pollTimeoutMs ?? 90_000);
  const pollIntervalMs = Number(config.pollIntervalMs ?? 8_000);
  const defaultPhone = config.defaultPhone ?? "11999999999";
  const defaultBirthDate = config.defaultBirthDate ?? "1990-01-01";
  const serviceAccounts = Array.isArray(config.serviceAccounts)
    ? config.serviceAccounts.filter((account) => account?.email && account?.password)
    : [];
  const store = config.store ?? null;

  // ==========================================================================
  // FASE 1 — descoberta dinâmica de turmas
  // ==========================================================================

  // Lista turmas ativas de uma tag via /v1/services/turmas (exige RS256 real).
  async function listActiveTurmasForTag({ tag, xApiKey, token, onLog = () => {} }) {
    const turmas = await artClient.listAllTurmas({ xApiKey, token, onLog });
    return turmas
      .filter((turma) => turma?.ativa === 1 && String(turma?.tag_curso ?? "").trim() === tag)
      .sort(compareTurmaDesc);
  }

  // Valida candidatos via prepare (roda SÓ com x-api-key, sem Bearer). Uma turma
  // só serve se o checkout oficial responder 200 com course.
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

  // Scan adaptativo de ids via prepare (só x-api-key). Recebe faixas [inicio,
  // fim] — turmas andam pra FRENTE (mudam várias vezes ao mês), então o alcance
  // à frente é alargado para cobrir saltos grandes (caso real: ancord 3396→4112).
  async function scanTurmasViaPrepare({ tag, xApiKey, ranges, onLog = () => {} }) {
    const ids = new Set();
    for (const range of ranges ?? []) {
      const start = Math.max(1, Math.floor(Number(range?.[0])));
      const end = Math.min(Math.floor(Number(range?.[1])), start + 1100);
      for (let idTurma = start; idTurma <= end; idTurma += 1) ids.add(idTurma);
    }
    const candidates = [...ids];
    if (!candidates.length) return [];
    onLog(`[turma] scan prepare: ${candidates.length} candidatos para tag=${tag}`);
    const valid = [];
    const concurrency = 20;
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

  // Descoberta de turmas SEM depender do cohort gravado. Camadas:
  //   1. SERVICE ACCOUNTS: login dedicado → /v1/services/turmas → filtro por tag
  //   2. SCAN ADAPTATIVO via prepare: âncoras (cohorts) + fronteira persistida
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
    const ranges = numericAnchors.map((anchor) => [anchor - 80, anchor + 1000]);
    const frontierStart = frontier ?? (numericAnchors.length ? Math.max(...numericAnchors) + 151 : 4130);
    ranges.push([frontierStart, frontierStart + 500]);
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

  // Resolve a turma de PROVISIONAMENTO a partir de candidatos explícitos.
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

  // Com o RS256 real do comprador, confirma/ajusta a turma dinamicamente.
  // Mantém a provisão se ela continuar ativa; senão usa a vigente real.
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

  // ==========================================================================
  // FASE 4 — recuperação em cascata (VETORES C/D/E + legado)
  // ==========================================================================

  function buildJsonRetorno({ profileId, tag, idCurso, idTurma, idOrder, idCart }) {
    return JSON.stringify({
      status: "APPROVED",
      free: {
        description: "",
        model: {
          id_usuario: Number(profileId),
          curso: tag,
          id_curso: Number(idCurso),
          id_turma: Number(idTurma),
          parcelas: 1,
          afiliado: "",
          cupom: "",
          metodo_pagamento: "free",
          ip_usuario: "177.197.91.84",
          promo_opt_in: false,
          promo_opt_in_at: null,
          id_order: Number(idOrder),
          id_cart: idCart ? Number(idCart) : null,
          valor: 0,
          status: "APPROVED",
        },
      },
    });
  }

  // [C] Flip determinístico: POST /v1/crud/orders/{id} reescreve
  // status=APPROVED + valor=0 + id_turma + json_retorno. Resolve DENIED.
  async function flipOrderToApproved({ idOrder, profileId, tag, idCurso, idTurma, idCart, xApiKey, token, onLog = () => {} }) {
    const payload = {
      status: "APPROVED",
      valor: 0,
      metodo_pagamento: "free",
      id_turma: Number(idTurma),
      json_retorno: buildJsonRetorno({ profileId, tag, idCurso, idTurma, idOrder, idCart }),
    };
    const result = await artClient.updateOrder({ idOrder, payload, xApiKey, token });
    const ok = result.status === 200 && String(result.text ?? "").trim() === "1";
    onLog(`[flip] POST order ${idOrder} (tag=${tag} turma=${idTurma}) -> HTTP ${result.status} ${ok ? "OK" : String(result.text ?? "").slice(0, 80)}`);
    return { flipped: ok, status: result.status, body: result.body, text: result.text };
  }

  // [D] Ajusta o id_turma de uma order para a turma que o APP aceita.
  async function fixOrderTurma({ idOrder, idTurma, xApiKey, token, onLog = () => {} }) {
    const result = await artClient.updateOrder({ idOrder, payload: { id_turma: Number(idTurma) }, xApiKey, token });
    const ok = result.status === 200 && String(result.text ?? "").trim() === "1";
    onLog(`[fix-turma] POST order ${idOrder} id_turma -> ${idTurma}: HTTP ${result.status} ${ok ? "OK" : String(result.text ?? "").slice(0, 80)}`);
    return { fixed: ok, status: result.status, body: result.body, text: result.text };
  }

  // Varre as orders do aluno por tag — findOrdersByStudent primeiro; se vier
  // vazio (não lista DENIED), fallback para scan GET /v1/crud/orders/{id}.
  async function findOrdersForTag({ idUsuario, tag, idCurso, xApiKey, getToken, onLog = () => {} }) {
    if (!idUsuario) return [];
    let listed;
    try {
      listed = await artClient.findOrdersByStudent({ idUsuario, xApiKey, token: getToken() });
    } catch {
      listed = { status: "error" };
    }
    let all = [];
    if (listed.status === 200) {
      const walk = (value) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const item of value) walk(item); return; }
        if (value.id_order) all.push(value);
        for (const item of Object.values(value)) walk(item);
      };
      walk(listed.body);
    } else {
      onLog(`[flip] findOrdersByStudent HTTP ${listed.status} — usando scan por range`);
    }
    if (!all.length) {
      onLog(`[flip] findOrdersByStudent vazio — scan GET /v1/crud/orders/{id} (range da conta)`);
      try {
        all = await artClient.scanOrdersByRange({ profileId: idUsuario, xApiKey, token: getToken(), onLog });
      } catch (error) {
        onLog(`[flip] scan por range falhou (${String(error).slice(0, 100)})`);
        all = [];
      }
    }
    const tagLower = String(tag ?? "").toLowerCase();
    return all.filter((order) => {
      const orderTag = String(order.tag ?? order.tag_curso ?? order.curso ?? "").toLowerCase();
      return orderTag === tagLower || (idCurso && Number(order.id_curso) === Number(idCurso));
    });
  }

  // Executa o polling de matrícula com renovação de sessão automática (401 não
  // é fatal — a plataforma revoga o token a cada login novo da mesma conta).
  // Por padrão respeita os timeouts/intervalo do CLIENT (waitForEnrollment); só
  // sobrescreve quando o chamador passar timeoutMs/intervalMs explicitamente.
  async function pollEnrollment({ tag, email, xApiKey, getToken, relogin, timeoutMs, intervalMs, onProbe, onLog = () => {} }) {
    const wait = await artClient.waitForEnrollment({
      tag,
      email,
      xApiKey,
      token: getToken(),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      onProbe,
      onUnauthorized: relogin,
      onProfileMissing: async () => { await artClient.syncStudentProfile({ xApiKey, token: getToken() }); },
    });
    return wait;
  }

  // Recuperação em cascata: tenta VETOR C → D → E e, se nenhum listar o curso
  // no app, devolve { flipped:true } para o chamador decidir (não destrói nada).
  async function tryFlipRecovery({ tag, idCurso, idTurmaVigente, idUsuario, email, xApiKey, getToken, relogin, comboTurmas = [], onLog = () => {} }) {
    const orders = await findOrdersForTag({ idUsuario, tag, idCurso, xApiKey, getToken, onLog });
    if (!orders.length) {
      onLog(`[flip] nenhuma order da tag=${tag} (findOrdersByStudent + scan vazios)`);
      return null;
    }
    onLog(`[flip] ${orders.length} order(s) da tag=${tag}: ${orders.map((o) => `${o.id_order}:${String(o.status ?? "").toUpperCase()}:${o.id_turma ?? "?"}`).join(", ")}`);

    const candidateTurmas = [...new Set([Number(idTurmaVigente), ...comboTurmas.map(Number).filter((n) => Number.isSafeInteger(n))])];
    const flippedIds = new Set();
    let flippedAny = false;

    // VETOR C + D: para cada order, flip para APPROVED (ou ajusta turma se já
    // APPROVED com turma divergente).
    for (const order of orders) {
      const oid = Number(order.id_order);
      const st = String(order.status ?? "").toUpperCase();
      if (st === "APPROVED") {
        const orderTurma = Number(order.id_turma) || null;
        if (orderTurma && candidateTurmas.length && !candidateTurmas.includes(orderTurma)) {
          const fixed = await fixOrderTurma({ idOrder: oid, idTurma: candidateTurmas[0], xApiKey, token: getToken(), onLog });
          if (fixed.fixed) flippedAny = true;
        }
        continue;
      }
      const cart = order.id_cart ?? null;
      const flipped = await flipOrderToApproved({ idOrder: oid, profileId: idUsuario, tag, idCurso, idTurma: candidateTurmas[0], idCart: cart, xApiKey, token: getToken(), onLog });
      if (flipped.flipped) {
        flippedAny = true;
        flippedIds.add(oid);
      }
    }

    // 1ª verificação pós-flip (C/D).
    let wait = await pollEnrollment({ tag, email, xApiKey, getToken, relogin, timeoutMs: 60_000, onLog });
    if (wait.enrollment) {
      return { enrollment: wait.enrollment, flipped: true, strategy: "flip-c" };
    }

    // VETOR E: para cada turma candidata alternativa (combo), troca e re-prova.
    for (const turma of candidateTurmas.slice(1)) {
      if (wait.enrollment) break;
      onLog(`[flip] tentando turma alternativa ${turma} (VETOR E)`);
      for (const order of orders) {
        const oid = Number(order.id_order);
        if (!flippedIds.has(oid) && String(order.status ?? "").toUpperCase() === "APPROVED") continue;
        await fixOrderTurma({ idOrder: oid, idTurma: turma, xApiKey, token: getToken(), onLog });
      }
      wait = await pollEnrollment({ tag, email, xApiKey, getToken, relogin, timeoutMs: 60_000, onLog });
      if (wait.enrollment) {
        return { enrollment: wait.enrollment, flipped: true, strategy: `flip-e-turma${turma}` };
      }
    }

    return flippedAny ? { enrollment: null, flipped: true, strategy: "flip-tried" } : null;
  }

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

  // [legado] DELETE + re-enroll — último recurso para PENDING zumbi (o flip já
  // tentou; aqui só age em orders que casam FORTEMENTE com tag/turma).
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
    const wait = await pollEnrollment({ tag, email, xApiKey, getToken, relogin, onLog });
    if (!wait.enrollment) return null;
    return { enrollment: wait.enrollment, deletedOrderId };
  }

  // ==========================================================================
  // FASE 0 — conta existente (evita duplicação e divergência de documento)
  // ==========================================================================

  async function resolveExistingAccount({ email, cpf, xApiKey, onLog = () => {} }) {
    for (const account of serviceAccounts) {
      try {
        const svcSession = await artClient.login(account.email, account.password);
        const found = await artClient.findStudent({ email, xApiKey, token: svcSession.token });
        if (found.status === 200 && found.body && typeof found.body === "object") {
          const doc = digitsOnly(found.body.documento);
          if (doc) {
            onLog(`[conta] e-mail ${email} JÁ TEM conta na ART (doc ...${doc.slice(-4)}; pedido ...${String(cpf).slice(-4)}) — reutilizando, sem provisionar`);
            return { cpf: doc, profile: found.body };
          }
        }
      } catch { /* service account indisponível — tenta a próxima */ }
    }
    return null;
  }

  // ==========================================================================
  // FASE 2 — provisionar conta nova ou logar em conta existente
  // ==========================================================================

  async function provisionOrLogin({ email, cpf, tag, fullName, turmaProvisao, buyerData, payloadDefaults, financialInstitution, affiliate, platformAccount, xApiKey, onLog }) {
    const effectiveCpf = platformAccount?.cpf ?? cpf;
    let session = null;
    let loginError = null;
    try {
      session = await artClient.login(email, effectiveCpf);
      onLog(`[enroll] login OK (conta existente) user_id=${session.userId}${effectiveCpf !== cpf ? ` doc plataforma ...${effectiveCpf.slice(-4)}` : ""}`);
    } catch (error) {
      loginError = error;
    }
    if (!session && platformAccount?.cpf && platformAccount.cpf !== digitsOnly(cpf)) {
      try {
        session = await artClient.login(email, platformAccount.cpf);
        onLog(`[enroll] re-login com CPF da plataforma user_id=${session.userId}`);
      } catch (retryError) {
        loginError = retryError;
      }
    }

    if (session) {
      onLog(`[enroll] conta existente user_id=${session.userId} (não provisiona conta nova)`);
      return { session, provisioned: false };
    }

    if (!turmaProvisao) {
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
    const phase1 = await artClient.startCheckoutProcess({ payload, xApiKey });
    onLog(`[enroll] fase1 HTTP ${phase1.status} (500/400 podem ser normais no provisionamento)`);
    const deadline = Date.now() + provisionTimeoutMs;
    while (Date.now() < deadline && !session) {
      await sleep(5000);
      try { session = await artClient.login(email, cpf); } catch { session = null; }
    }
    if (!session) throw new Error(`conta nao provisionou em ${provisionTimeoutMs}ms`);
    onLog(`[enroll] conta provisionada user_id=${session.userId} (senha=CPF confirmada pelo login)`);
    return { session, provisioned: true };
  }

  // ==========================================================================
  // FLUXO PRINCIPAL
  // ==========================================================================

  async function enrollStudent({ email, cpf, tag, fullName, phone = null, birthDate = null, address = null, financialInstitution = "", affiliate = "", candidateTurmas = null, comboTurmas = null, onLog = () => {} }) {
    const xApiKey = generateXApiKey();
    const provisionCandidates = candidateTurmas ?? (getCohortBySourceTag(tag) ? [getCohortBySourceTag(tag)] : null);

    const payloadDefaults = { phone: defaultPhone, birthDate: defaultBirthDate };
    const buyerData = {
      phone: phone || null,
      birthDate: birthDate || null,
      ...(address ?? {}),
    };

    // --- FASE 1: turma dinâmica (camadas) ---
    let turmaProvisao = null;
    if (serviceAccounts.length) {
      const discovered = await discoverTurmasVivas({ tag, xApiKey, anchors: provisionCandidates, onLog });
      if (discovered.length) {
        turmaProvisao = pickVigente(discovered);
        onLog(`[turma] descoberta ao vivo (service account) resolveu ${turmaProvisao.idTurma} (${turmaProvisao.selectionReason})`);
      }
    }
    if (!turmaProvisao) {
      try {
        turmaProvisao = await resolveTurma({ tag, candidateTurmas: provisionCandidates, xApiKey, onLog });
      } catch (error) {
        onLog(`[turma] cohort morto (${String(error).slice(0, 120)}) — scan adaptativo alargado`);
        const discovered = await discoverTurmasVivas({ tag, xApiKey, anchors: provisionCandidates, onLog });
        if (discovered.length) {
          turmaProvisao = pickVigente(discovered);
          onLog(`[turma] scan adaptativo resolveu provisao ${turmaProvisao.idTurma} (${turmaProvisao.selectionReason})`);
        }
      }
    }

    // --- FASE 0: conta existente (evita duplicar / divergência de documento) ---
    let platformAccount = null;
    try {
      platformAccount = await resolveExistingAccount({ email, cpf, xApiKey, onLog });
    } catch { platformAccount = null; }

    // --- FASE 2: login ou provisão ---
    let { session } = await provisionOrLogin({
      email, cpf, tag, fullName, turmaProvisao, buyerData, payloadDefaults,
      financialInstitution, affiliate, platformAccount, xApiKey, onLog,
    });

    // Catálogo morto + conta existente: descoberta autêntica via RS256 do comprador.
    if (!turmaProvisao) {
      const ativas = await listActiveTurmasForTag({ tag, xApiKey, token: session.token, onLog });
      const valid = await validateCandidatesViaPrepare({ tag, candidates: ativas, xApiKey });
      if (!valid.length) throw new Error(`nenhuma turma com checkout ativo para tag=${tag} mesmo via descoberta RS256`);
      turmaProvisao = pickVigente(valid);
      onLog(`[turma] descoberta-RS256 resolveu provisao ${turmaProvisao.idTurma} (fallback de catalogo morto, ultima=${valid[0].idTurma}, total=${valid.length})`);
    }

    // Confirma/ajusta a turma dinamicamente com o RS256 real.
    const turma = await refineTurmaDinamica({ tag, turmaProvisao, xApiKey, rs256: session.token, onLog });
    const idTurma = turma.idTurma;
    const resolvedFinancialInstitution = financialInstitution || (turma.requiresFinancialInstitution ? "998" : "");
    onLog(`[enroll] inicio email=${email} tag=${tag} turma=${idTurma} (${turma.selectionReason}) fi=${resolvedFinancialInstitution || "-"}`);

    // Self-healing de cohort (2026-08-01): o motor descobriu a turma viva real;
    // se ela divergir do cohort gravado no catálogo, atualiza o banco (products)
    // e o catálogo em memória para manter tudo sincronizado sem manutenção
    // manual — e para o scan adaptativo da próxima ativação começar perto do
    // alvo. Best-effort: nunca bloqueia nem falha a ativação se o update der erro.
    const cohortGravado = getCohortBySourceTag(tag);
    if (cohortGravado && Number(cohortGravado) !== Number(idTurma)) {
      syncCohortBySourceTag(tag, String(idTurma));
      if (store?.updateProductCohortBySourceTag) {
        try {
          await store.updateProductCohortBySourceTag(tag, String(idTurma));
          onLog(`[cohort] auto-sync: products.source_tag=${tag} cohort ${cohortGravado} -> ${idTurma} (turma viva descoberta ao vivo)`);
        } catch (error) {
          onLog(`[cohort] auto-sync falhou (best-effort): ${String(error).slice(0, 120)}`);
        }
      }
    }

    // Identidade alinhada ao perfil da plataforma (documento real manda).
    let platformProfile = platformAccount?.profile ?? null;
    try {
      const found = await artClient.findStudent({ email, xApiKey, token: session.token });
      if (found.status === 200 && found.body && typeof found.body === "object") platformProfile = found.body;
    } catch { /* sonda tolerante */ }
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

    // --- FASE 3: efetivação + polling curto ---
    const phase2 = await artClient.startCheckoutProcess({ payload, xApiKey, token: session.token });
    onLog(`[enroll] fase2 HTTP ${phase2.status}: ${String(phase2.text ?? "").slice(0, 180)}`);
    const pending = phase2.status === 400 || phase2.status === 500;

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

    let wait = await pollEnrollment({
      tag, email, xApiKey, getToken: () => session.token, relogin,
      onProbe: ({ probe, status, courseCount, relogin: relogging, profileResync }) => onLog(`[enroll] probe ${probe} HTTP ${status} cursos=${courseCount ?? "?"}${relogging ? " (401 -> renovando sessao)" : ""}${profileResync ? " (perfil ausente -> re-sync)" : ""}`),
      onLog,
    });

    if (!wait.enrollment) {
      // --- FASE 4: recuperação em cascata ---
      // 1. FLIP (VETOR C) + swap turma (D) + combo (E)
      const flipRecovery = await tryFlipRecovery({
        tag,
        idCurso: Number(turma.course?.id_curso) || null,
        idTurmaVigente: idTurma,
        idUsuario: platformProfile?.id_usuario ?? session.raw?.profile_id ?? session.raw?.id ?? session.raw?.id_usuario ?? null,
        email,
        xApiKey,
        getToken: () => session.token,
        relogin,
        comboTurmas: Array.isArray(comboTurmas) ? comboTurmas : [],
        onLog,
      });
      if (flipRecovery?.enrollment) {
        return { status: "CONFIRMED", userId: session.userId, idTurma, turmaSelection: turma.selectionReason, enrollment: flipRecovery.enrollment, flipRecovery: true, strategy: flipRecovery.strategy, phase2Http: phase2.status };
      }
      if (flipRecovery?.flipped) {
        return { status: pending ? "PENDING" : "NOT_CREATED", userId: session.userId, idTurma, turmaSelection: turma.selectionReason, phase2Http: phase2.status, flipApplied: true };
      }
      // 2. DELETE + re-enroll (legado, último recurso)
      const recovery = await recoverStuckPendingOrder({
        tag,
        idTurma,
        email,
        idUsuario: platformProfile?.id_usuario ?? session.raw?.profile_id ?? session.raw?.id ?? session.raw?.id_usuario ?? null,
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

  // ==========================================================================
  // Consultas e cancelamento
  // ==========================================================================

  async function listStudentCourses({ email, cpf }) {
    const xApiKey = generateXApiKey();
    const session = await artClient.login(email, cpf);
    const { status, body } = await artClient.findCoursesByStudent({ email, xApiKey, token: session.token });
    if (status !== 200 || !Array.isArray(body)) {
      throw new Error(`findCoursesByStudent HTTP ${status}: ${String(body).slice(0, 300)}`);
    }
    return body;
  }

  async function cancelStudentCourse({ email, cpf, tag, onLog = () => {} }) {
    const xApiKey = generateXApiKey();
    let session = null;
    let loginError = null;
    try {
      onLog(`[cancel] login ${email}`);
      session = await artClient.login(email, cpf);
    } catch (error) {
      loginError = error;
    }
    if (!session) {
      let platformCpf = null;
      for (const account of serviceAccounts) {
        try {
          const svcSession = await artClient.login(account.email, account.password);
          const found = await artClient.findStudent({ email, xApiKey, token: svcSession.token });
          if (found.status === 200 && found.body && typeof found.body === "object") {
            platformCpf = digitsOnly(found.body.documento);
            if (platformCpf) {
              onLog(`[cancel] CPF do pedido ...${String(cpf).slice(-4)} diverge da plataforma ...${platformCpf.slice(-4)} — usando o da plataforma`);
              break;
            }
          }
        } catch { /* service account indisponível */ }
      }
      if (platformCpf && platformCpf !== digitsOnly(cpf)) {
        try {
          onLog(`[cancel] re-login com CPF da plataforma`);
          session = await artClient.login(email, platformCpf);
        } catch (retryError) {
          loginError = retryError;
        }
      }
    }
    if (!session) {
      throw new Error(`login ART falhou para ${email}: ${String(loginError).slice(0, 200)}`);
    }

    const { status, body } = await artClient.findCoursesByStudent({ email, xApiKey, token: session.token });
    if (status !== 200 || !Array.isArray(body)) {
      throw new Error(`findCoursesByStudent HTTP ${status}: ${String(body).slice(0, 300)}`);
    }
    const matching = body.filter((course) => course?.tag === tag);
    if (!matching.length) {
      onLog(`[cancel] nenhum curso encontrado para tag=${tag}`);
      return { deleted: 0, tags: [] };
    }
    const deletedTags = [];
    for (const course of matching) {
      const orderId = course.id_order ?? course.idOrder;
      if (!orderId) continue;
      const del = await artClient.deleteOrder({ idOrder: orderId, xApiKey, token: session.token });
      const ok = del.status === 200 && String(del.text ?? "").trim() === "1";
      onLog(`[cancel] DELETE order ${orderId} (tag=${course.tag}) -> HTTP ${del.status}${ok ? " OK" : " FALHOU"}`);
      if (ok) deletedTags.push(course.tag);
    }
    if (deletedTags.length) {
      const recheck = await artClient.findCoursesByStudent({ email, xApiKey, token: session.token });
      if (recheck.status === 200 && Array.isArray(recheck.body)) {
        for (const course of recheck.body.filter((c) => c?.tag === tag)) {
          const orderId = course.id_order ?? course.idOrder;
          if (!orderId) continue;
          const del = await artClient.deleteOrder({ idOrder: orderId, xApiKey, token: session.token });
          if (del.status === 200 && String(del.text ?? "").trim() === "1") {
            onLog(`[cancel] DELETE order bundled ${orderId} (tag=${course.tag}) -> OK`);
            if (!deletedTags.includes(course.tag)) deletedTags.push(course.tag);
          }
        }
      }
    }
    onLog(`[cancel] ${deletedTags.length} order(s) deletada(s) para tag=${tag}`);
    return { deleted: deletedTags.length, tags: deletedTags };
  }

  return Object.freeze({ enrollStudent, listStudentCourses, cancelStudentCourse, resolveTurma, listActiveTurmasForTag });
}
