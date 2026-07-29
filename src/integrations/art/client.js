import { setTimeout as sleep } from "node:timers/promises";
import { headersFor } from "./credentials.js";

export class ArtApiError extends Error {
  constructor(message, { endpoint, status } = {}) {
    super(message);
    this.name = "ArtApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

// Cliente HTTP da plataforma ART (Academia Rafael Toro). Espelha o fluxo real
// validado: login no IDM, checkout, turmas e polling de matrícula.
export function createArtClient(config = {}, fetchImplementation = fetch) {
  const apiOrigin = String(config.apiOrigin ?? "https://api.academiarafaeltoro.com.br").replace(/\/$/, "");
  const idmOrigin = String(config.idmOrigin ?? "https://ms-idm.academiarafaeltoro.com.br").replace(/\/$/, "");
  const requestTimeoutMs = Number(config.requestTimeoutMs ?? 30_000);
  const pollTimeoutMs = Number(config.pollTimeoutMs ?? 1_800_000);
  const pollIntervalMs = Number(config.pollIntervalMs ?? 10_000);

  async function requestJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? requestTimeoutMs);
    let response;
    try {
      response = await fetchImplementation(url, { ...options, signal: controller.signal });
    } catch (error) {
      throw new ArtApiError("A plataforma ART não respondeu a tempo.", {
        endpoint: url,
        status: error?.name === "AbortError" ? "timeout" : "network_error",
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: response.status, body, text };
  }

  async function login(email, password) {
    const { status, body } = await requestJson(`${idmOrigin}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = body?.response?.data;
    if (status >= 200 && status < 300 && body?.response?.status === "SUCCESS" && data?.token) {
      return { token: data.token, userId: String(data.id ?? data.user_id ?? ""), raw: data };
    }
    throw new ArtApiError(`login ART falhou HTTP ${status}`, { endpoint: `${idmOrigin}/api/login`, status });
  }

  function prepareCheckout({ tag, idTurma, xApiKey, token }) {
    const url = new URL(`${apiOrigin}/v1/checkout/prepare`);
    url.searchParams.set("tag", tag);
    url.searchParams.set("id_turma", String(idTurma));
    return requestJson(url, { headers: headersFor(xApiKey, token) });
  }

  function listTurmasPage({ page, xApiKey, token }) {
    const url = new URL(`${apiOrigin}/v1/services/turmas`);
    url.searchParams.set("page", String(page));
    return requestJson(url, { headers: headersFor(xApiKey, token) });
  }

  async function listAllTurmas({ xApiKey, token, maxPages = 200, onLog }) {
    const turmas = [];
    let page = 1;
    let lastPage = null;
    while (page <= maxPages) {
      const { status, body } = await listTurmasPage({ page, xApiKey, token });
      if (status !== 200 || !Array.isArray(body?.data)) {
        onLog?.(`[turmas] pagina ${page} HTTP ${status}; parada antecipada`);
        break;
      }
      turmas.push(...body.data);
      lastPage = Number(body.last_page ?? lastPage ?? page);
      if (page >= lastPage) break;
      page += 1;
    }
    return turmas;
  }

  function findStudent({ email, xApiKey, token }) {
    const url = new URL(`${apiOrigin}/v1/checkout/findStudent`);
    url.searchParams.set("email", email);
    return requestJson(url, { headers: headersFor(xApiKey, token) });
  }

  // Lista TODAS as orders do aluno — inclusive PENDING, que é invisível no
  // findCoursesByStudent (pesquisa: art_cancel_test.py / art_unenroll_all.py).
  function findOrdersByStudent({ idUsuario, xApiKey, token }) {
    return requestJson(`${apiOrigin}/v1/services/aluno/findOrdersByStudent`, {
      method: "POST",
      headers: headersFor(xApiKey, token, true),
      body: JSON.stringify({ id_usuario: Number(idUsuario) }),
    });
  }

  // Soft delete de order (técnica confirmada na pesquisa: resposta body "1").
  // Usado para destravar order PENDING zumbi antes do re-enroll determinístico.
  function deleteOrder({ idOrder, xApiKey, token }) {
    return requestJson(`${apiOrigin}/v1/crud/orders/${encodeURIComponent(String(idOrder))}`, {
      method: "DELETE",
      headers: headersFor(xApiKey, token),
    });
  }

  function findCoursesByStudent({ email, xApiKey, token }) {
    const url = new URL(`${apiOrigin}/v1/services/aluno/findCoursesByStudent`);
    url.searchParams.set("email", email);
    return requestJson(url, { headers: headersFor(xApiKey, token) });
  }

  async function syncStudentProfile({ xApiKey, token }) {
    // 405/erro de transporte ainda pode ter criado o perfil; a prova vem do polling.
    try {
      await requestJson(`${apiOrigin}/v1/services/student/metrics`, { headers: headersFor(xApiKey, token) });
    } catch { /* noop */ }
  }

  function startCheckoutProcess({ payload, xApiKey, token }) {
    return requestJson(`${apiOrigin}/v1/checkout/process/start`, {
      method: "POST",
      headers: headersFor(xApiKey, token, true),
      body: JSON.stringify(payload),
    });
  }

  // Polling RS256 da matrícula. O 401 aqui NÃO é mais fatal: a plataforma revoga
  // o token de outra sessão a cada login novo da mesma conta (rotação), e processos
  // concorrentes (segunda instância da API, retry antigo) logavam guerra de tokens.
  // Com onUnauthorized, o polling renova a sessão com jitter e SEGUE esperando —
  // um 401 vira apenas uma pausa, não uma tentativa perdida.
  async function waitForEnrollment({ tag, email, xApiKey, token, timeoutMs, intervalMs, onProbe, onUnauthorized, onProfileMissing }) {
    const deadline = Date.now() + Number(timeoutMs ?? pollTimeoutMs);
    const interval = Number(intervalMs ?? pollIntervalMs);
    const maxRelogins = 5;
    const maxProfileResyncs = 3;
    let probe = 0;
    let relogins = 0;
    let profileResyncs = 0;
    let currentToken = token;
    while (Date.now() < deadline) {
      probe += 1;
      const { status, body, text } = await findCoursesByStudent({ email, xApiKey, token: currentToken });
      if (status === 200 && Array.isArray(body)) {
        const hit = body.find((course) => course?.tag === tag);
        if (hit) return { enrollment: hit, probe, courses: body };
        onProbe?.({ probe, status, courseCount: body.length });
      } else if (status === 500 && String(text ?? "").includes("id_usuario") && onProfileMissing && profileResyncs < maxProfileResyncs) {
        // Finding #3 da pesquisa (08-FLUXO-DETERMINISTICO): 500 "id_usuario
        // non-object" = linha do aluno ainda não existe. Re-dispara o side
        // effect do student/metrics e segue esperando em vez de queimar polling.
        profileResyncs += 1;
        onProbe?.({ probe, status, courseCount: null, profileResync: true });
        await onProfileMissing();
      } else if (status === 401 && onUnauthorized && relogins < maxRelogins) {
        relogins += 1;
        onProbe?.({ probe, status, courseCount: null, relogin: true });
        // Jitter antes do re-login: se havia outra sessão concorrente da conta,
        // o último login vence a rotação — o perdedor para de disputar.
        await sleep(interval + Math.floor(Math.random() * (interval + 1)));
        const nextToken = await onUnauthorized();
        if (!nextToken) {
          throw new ArtApiError("sessao perdida (401) e re-login indisponivel durante polling", { endpoint: "findCoursesByStudent", status });
        }
        currentToken = nextToken;
      } else {
        onProbe?.({ probe, status, courseCount: null });
        if (status === 401) throw new ArtApiError("token revogado/invalido durante polling (401), sem re-login possivel", { endpoint: "findCoursesByStudent", status });
      }
      await sleep(interval);
    }
    return { enrollment: null, probe, courses: null };
  }

  return Object.freeze({
    login,
    prepareCheckout,
    listTurmasPage,
    listAllTurmas,
    findStudent,
    findOrdersByStudent,
    deleteOrder,
    findCoursesByStudent,
    syncStudentProfile,
    startCheckoutProcess,
    waitForEnrollment,
  });
}
