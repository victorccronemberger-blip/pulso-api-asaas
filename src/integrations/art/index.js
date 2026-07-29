import { Agent } from "undici";
import { createArtClient } from "./client.js";
import { createEnrollmentService } from "./enrollment.js";
import { createEnrollmentQueue } from "./queue.js";

// Monta a integração ART completa a partir do ambiente. Devolve null quando a
// matrícula automática está desligada (ENROLLMENT_ENABLED=false), mantendo o resto
// da API intacto. O TLS skip (ART_TLS_REJECT_UNAUTHORIZED=0) vale SOMENTE para as
// chamadas ART via dispatcher dedicado — o provedor de pagamento segue com TLS cheio.
export function createArtIntegration({ environment, store, log = console.log }) {
  if (!environment.enrollmentEnabled) return null;

  let fetchImplementation = fetch;
  if (!environment.artTlsRejectUnauthorized) {
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    fetchImplementation = (url, options = {}) => fetch(url, { ...options, dispatcher });
    log("[enrollment] ART TLS verification disabled (ART_TLS_REJECT_UNAUTHORIZED=0).");
  }

  const artClient = createArtClient({
    apiOrigin: environment.artApiOrigin,
    idmOrigin: environment.artIdmOrigin,
    requestTimeoutMs: environment.artRequestTimeoutMs,
    pollTimeoutMs: environment.artPollTimeoutMs,
    pollIntervalMs: environment.artPollIntervalMs,
  }, fetchImplementation);

  const enrollmentService = createEnrollmentService(artClient, {
    provisionTimeoutMs: environment.artProvisionTimeoutMs,
    serviceAccounts: environment.artServiceAccounts,
    store,
  });

  const queue = createEnrollmentQueue({ store, enrollmentService, environment, log });

  return Object.freeze({ artClient, enrollmentService, queue });
}
