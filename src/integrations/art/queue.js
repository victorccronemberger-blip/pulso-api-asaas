import { setTimeout as sleep } from "node:timers/promises";
import { getSourceTag } from "../../domain/catalog.js";

const STATUS_BY_RESULT = { CONFIRMED: "confirmed", PENDING: "pending", NOT_CREATED: "not_created" };

// Fila serializada de matrículas. Um job por vez porque o login na plataforma ART
// revoga o token RS256 anterior — dois logins paralelos da mesma conta quebram o
// polling. A persistência (tabela enrollments) é a fonte de verdade: o processo pode
// reiniciar que os jobs 'processing' voltam a 'queued' no boot.
export function createEnrollmentQueue({ store, enrollmentService, environment, log = console.log }) {
  const maxRetries = environment.artMaxRetries;
  const retryDelayMs = environment.artRetryDelayMs;
  let draining = false;
  let shuttingDown = false;
  let runningJobId = null;

  function processOnce(job) {
    return enrollmentService.enrollStudent({
      email: job.buyerEmail,
      cpf: job.buyerCpf,
      tag: job.sourceTag,
      fullName: job.buyerName ?? "",
      onLog: (line) => log(`${new Date().toISOString()} [enrollment:${job.id}] ${line}`),
    });
  }

  async function processWithRetry(job) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await processOnce(job);
        await store.finishEnrollmentJob(job.id, {
          status: STATUS_BY_RESULT[result.status] ?? "not_created",
          idTurma: result.idTurma ?? null,
          turmaSelection: result.turmaSelection ?? null,
          userId: result.userId ?? null,
          result,
        });
        log(`[enrollment:${job.id}] finished status=${result.status} turma=${result.idTurma ?? "?"}`);
        return result;
      } catch (error) {
        lastError = error;
        log(`[enrollment:${job.id}] attempt ${attempt}/${maxRetries} failed: ${String(error)}`);
        if (attempt < maxRetries) await sleep(retryDelayMs);
      }
    }
    await store.finishEnrollmentJob(job.id, { status: "failed", error: String(lastError).slice(0, 512) });
    log(`[enrollment:${job.id}] FAILED after ${maxRetries} attempts`);
    return null;
  }

  async function drain() {
    if (draining || shuttingDown) return;
    draining = true;
    try {
      while (!shuttingDown) {
        const [next] = await store.listPendingEnrollmentJobs();
        if (!next) break;
        const claimed = await store.claimEnrollmentJob(next.id);
        if (!claimed) continue;
        runningJobId = next.id;
        try {
          await processWithRetry(next);
        } finally {
          runningJobId = null;
        }
      }
    } finally {
      draining = false;
    }
  }

  function wake() { void drain(); }

  async function enqueueOrder(order) {
    if (!order) return { created: 0, skipped: [] };
    if (!order.buyerEmail || !order.buyerCpf) {
      log(`[enrollment] order ${order.id} granted access but missing buyer email/cpf — cannot auto-enroll`);
      return { created: 0, skipped: (order.items ?? []).map((item) => item.courseSlug) };
    }
    let created = 0;
    const skipped = [];
    for (const item of order.items ?? []) {
      const sourceTag = getSourceTag(item.courseSlug);
      if (!sourceTag) { skipped.push(item.courseSlug); continue; }
      const id = await store.createEnrollmentJob({
        orderId: order.id,
        orderItemId: item.id ?? null,
        customerId: order.customerId ?? null,
        courseSlug: item.courseSlug,
        sourceTag,
        buyerEmail: order.buyerEmail,
        buyerCpf: order.buyerCpf,
        buyerName: order.buyerName ?? null,
      });
      if (id) created += 1;
    }
    if (skipped.length) log(`[enrollment] order ${order.id} skipped slugs without ART tag: ${skipped.join(", ")}`);
    if (created) wake();
    return { created, skipped };
  }

  async function enqueueManualActivation({
    customerId,
    email,
    cpf,
    fullName,
    courseSlugs,
  }) {
    let created = 0;
    const skipped = [];
    const enrollmentIds = [];
    for (const courseSlug of courseSlugs) {
      const sourceTag = getSourceTag(courseSlug);
      if (!sourceTag) {
        skipped.push({ courseSlug, reason: "course_not_mapped" });
        continue;
      }
      const enrollmentId = await store.createEnrollmentJob({
        orderId: null,
        orderItemId: null,
        customerId,
        courseSlug,
        sourceTag,
        buyerEmail: email,
        buyerCpf: cpf,
        buyerName: fullName,
      });
      if (!enrollmentId) {
        skipped.push({ courseSlug, reason: "already_activated" });
        continue;
      }
      enrollmentIds.push(enrollmentId);
      created += 1;
    }
    if (created) wake();
    return { created, skipped, enrollmentIds };
  }

  async function start() {
    const recovered = await store.recoverStaleEnrollments();
    if (recovered) log(`[enrollment] recovered ${recovered} stale job(s) from previous run`);
    wake();
  }

  async function shutdown(timeoutMs = 60_000) {
    shuttingDown = true;
    const deadline = Date.now() + timeoutMs;
    while (runningJobId && Date.now() < deadline) await sleep(500);
    if (runningJobId) log(`[enrollment] shutdown timeout; job ${runningJobId} still running`);
  }

  function status() {
    return { enabled: true, draining, shuttingDown, runningJobId };
  }

  return Object.freeze({
    enqueueOrder,
    enqueueManualActivation,
    start,
    shutdown,
    status,
    wake,
  });
}
