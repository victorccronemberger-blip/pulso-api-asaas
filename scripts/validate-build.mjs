await Promise.all([
  import("../src/application.js"),
  import("../src/admin/in-memory-store.js"),
  import("../src/admin/mysql-store.js"),
  import("../src/admin/security.js"),
  import("../src/admin/validation.js"),
  import("../src/config/environment.js"),
  import("../src/http/error-handler.js"),
  import("../src/http/request-context.js"),
  import("../src/domain/catalog.js"),
  import("../src/domain/payment-status.js"),
  import("../src/domain/provider-values.js"),
  import("../src/domain/quote.js"),
  import("../src/integrations/asaas/client.js"),
  import("../src/services/installment-service.js"),
  import("../src/routes/asaas-integration.js"),
  import("../src/routes/admin.js"),
  import("../src/routes/checkout.js"),
  import("../src/routes/health.js"),
]);

const forbiddenSource = /\b(?:alg\s*[:=]\s*["']none|forgeTransportJwt|ART_CARRIER_USER_IDS)\b/i;
async function assertNoUnsafeEnrollmentCode(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoUnsafeEnrollmentCode(target);
    else if (entry.name.endsWith(".js") && forbiddenSource.test(await readFile(target, "utf8"))) {
      throw new Error(`Unsafe enrollment transport code found in ${target}.`);
    }
  }
}
await assertNoUnsafeEnrollmentCode(fileURLToPath(new URL("../src", import.meta.url)));

console.log("PULSO API source validated.");
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
