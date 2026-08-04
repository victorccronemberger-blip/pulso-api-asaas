import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { resolveOrderStatus } from "./order-status.js";
import { summarizeInstallmentPlan } from "../domain/payment-status.js";

const asJson = (value) => JSON.stringify(value ?? []);
const fromJson = (value, fallback = []) => {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const iso = (value) => value ? new Date(value).toISOString() : null;
const coupon = (row) => row && ({
  id: row.id,
  code: row.code,
  discountBps: row.discount_bps,
  active: Boolean(row.active),
  startsAt: iso(row.starts_at),
  endsAt: iso(row.ends_at),
  maxRedemptions: row.max_redemptions,
  productSlugs: fromJson(row.product_scope_json),
  redemptions: Number(row.redemptions ?? 0),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
const paymentInstallment = (row) => row && ({
  providerPaymentId: row.provider_payment_id,
  providerGroupId: row.provider_group_id,
  number: Number(row.installment_number),
  status: row.status,
  dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
  amountCents: Number(row.amount_cents),
  paymentUrl: row.payment_url,
  paidAt: iso(row.paid_at),
});

// Todas as tabelas usam o prefixo pulso_ porque o banco é compartilhado com o
// LMS (pulso.cyara.com.br), cujo install.sql cria tabelas próprias — incluindo
// `coupons` e `enrollments`, que colidiriam com nomes sem prefixo.
export function createMySqlStore(databaseUrl) {
  const url = new URL(databaseUrl);
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    timezone: "Z",
    dateStrings: true,
  });
  let ready;
  async function ensureSchema() {
    if (ready) return ready;
    ready = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS pulso_products (slug VARCHAR(80) PRIMARY KEY, source_tag VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, description TEXT NOT NULL, category_id VARCHAR(60) NOT NULL, kind VARCHAR(32) NOT NULL, accent CHAR(7) NULL, cohort VARCHAR(40) NULL, course_year VARCHAR(8) NULL, official_price_cents INT UNSIGNED NOT NULL, price_cents INT UNSIGNED NOT NULL, featured TINYINT(1) NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, image_url VARCHAR(500) NULL, image_600_url VARCHAR(500) NULL, image_alt VARCHAR(255) NULL, keywords_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX pulso_products_active_order (active,sort_order,title), UNIQUE INDEX pulso_products_source_tag (source_tag))`,
        `CREATE TABLE IF NOT EXISTS pulso_coupons (id CHAR(36) PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, discount_bps SMALLINT UNSIGNED NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, starts_at DATETIME(3) NULL, ends_at DATETIME(3) NULL, max_redemptions INT UNSIGNED NULL, product_scope_json JSON NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX pulso_coupons_active (active, starts_at, ends_at))`,
        `CREATE TABLE IF NOT EXISTS pulso_orders (id CHAR(36) PRIMARY KEY, provider VARCHAR(24) NOT NULL, provider_order_id VARCHAR(80) NOT NULL, provider_group_id VARCHAR(80) NULL, status VARCHAR(32) NOT NULL, buyer_email VARCHAR(160) NULL, buyer_cpf VARCHAR(14) NULL, buyer_name VARCHAR(180) NULL, buyer_phone VARCHAR(13) NULL, buyer_birth_date VARCHAR(10) NULL, buyer_address_json JSON NULL, payment_method VARCHAR(24) NULL, installments TINYINT UNSIGNED NULL, installment_cents INT UNSIGNED NULL, subtotal_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, total_cents INT UNSIGNED NOT NULL, paid_cents INT UNSIGNED NOT NULL DEFAULT 0, paid_installments TINYINT UNSIGNED NOT NULL DEFAULT 0, access_granted_at DATETIME(3) NULL, coupon_code VARCHAR(32) NULL, coupon_redeemed TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX pulso_orders_provider_order (provider, provider_order_id), INDEX pulso_orders_provider_group (provider, provider_group_id), INDEX pulso_orders_status_updated (status, updated_at))`,
        `CREATE TABLE IF NOT EXISTS pulso_order_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL, course_slug VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, base_price_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, final_price_cents INT UNSIGNED NOT NULL, CONSTRAINT pulso_order_items_order_fk FOREIGN KEY (order_id) REFERENCES pulso_orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS pulso_payment_installments (id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, provider VARCHAR(24) NOT NULL DEFAULT 'asaas', provider_payment_id VARCHAR(80) NOT NULL, provider_group_id VARCHAR(80) NOT NULL, installment_number TINYINT UNSIGNED NOT NULL, status VARCHAR(24) NOT NULL, due_date DATE NULL, amount_cents INT UNSIGNED NOT NULL DEFAULT 0, payment_url VARCHAR(500) NULL, paid_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX pulso_installments_provider_payment (provider, provider_payment_id), UNIQUE INDEX pulso_installments_order_number (order_id, installment_number), INDEX pulso_installments_order_status (order_id, status, due_date), CONSTRAINT pulso_installments_order_fk FOREIGN KEY (order_id) REFERENCES pulso_orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS pulso_coupon_redemptions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, order_id CHAR(36) NOT NULL UNIQUE, redeemed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX pulso_coupon_redemptions_code (coupon_code))`,
        `CREATE TABLE IF NOT EXISTS pulso_coupon_reservations (attempt_key CHAR(36) PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, provider VARCHAR(24) NULL, provider_order_id VARCHAR(80) NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX pulso_reservations_provider_order (provider, provider_order_id), INDEX pulso_reservations_code_expiry (coupon_code, expires_at))`,
        `CREATE TABLE IF NOT EXISTS pulso_checkout_attempts (idempotency_key CHAR(36) PRIMARY KEY, fingerprint CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, response_json JSON NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX pulso_attempts_expiry (expires_at))`,
        `CREATE TABLE IF NOT EXISTS pulso_webhook_events (event_id VARCHAR(128) PRIMARY KEY, received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
      ];
      for (const sql of statements) await pool.query(sql);
    })();
    return ready;
  }
  const id = () => crypto.randomUUID();

  async function redeemCoupon(connection, order) {
    if (!order.coupon_code || order.coupon_redeemed) return;
    const [[reservation]] = await connection.query(
      "SELECT attempt_key FROM pulso_coupon_reservations WHERE provider=? AND provider_order_id=? FOR UPDATE",
      [order.provider, order.provider_order_id],
    );
    if (!reservation) throw new Error("Paid order has no coupon reservation.");
    await connection.query(
      "INSERT IGNORE INTO pulso_coupon_redemptions (coupon_code,order_id) VALUES (?,?)",
      [order.coupon_code, order.id],
    );
    await connection.query("UPDATE pulso_orders SET coupon_redeemed=1 WHERE id=?", [order.id]);
    await connection.query(
      "DELETE FROM pulso_coupon_reservations WHERE attempt_key=?",
      [reservation.attempt_key],
    );
  }

  async function reconcileInstallmentOrder(connection, order) {
    const [storedRows] = await connection.query(
      "SELECT * FROM pulso_payment_installments WHERE order_id=? ORDER BY installment_number",
      [order.id],
    );
    const summary = summarizeInstallmentPlan(
      storedRows.map(paymentInstallment),
      Number(order.installments ?? 0),
    );
    const hadAccess = Boolean(order.access_granted_at);
    await connection.query(
      `UPDATE pulso_orders SET status=?,paid_cents=?,paid_installments=?,
       access_granted_at=CASE WHEN ? > 0 THEN COALESCE(access_granted_at,NOW(3)) ELSE access_granted_at END
       WHERE id=?`,
      [summary.status, summary.paidCents, summary.paidInstallments, summary.paidInstallments, order.id],
    );
    if (summary.paidInstallments > 0) await redeemCoupon(connection, order);
    return {
      id: order.id,
      status: summary.status,
      previousStatus: order.status,
      accessGrantedNow: !hadAccess && summary.paidInstallments > 0,
    };
  }

  return {
    ensureSchema,
    async close() { await pool.end(); },
    async listCatalogProducts({ activeOnly = true } = {}) {
      await ensureSchema();
      const [rows] = await pool.query(`SELECT slug,source_tag AS sourceTag,title,description,category_id AS categoryId,kind,accent,cohort,course_year AS year,official_price_cents AS officialPriceCents,price_cents AS priceCents,featured,active,sort_order AS sortOrder,image_url AS imageUrl,image_600_url AS image600Url,image_alt AS imageAlt,keywords_json AS keywordsJson FROM pulso_products ${activeOnly ? "WHERE active=1" : ""} ORDER BY sort_order ASC,title ASC`);
      return rows.map((row) => ({ ...row, officialPriceCents: Number(row.officialPriceCents), priceCents: Number(row.priceCents), featured: Boolean(row.featured), active: Boolean(row.active), keywords: fromJson(row.keywordsJson, []) }));
    },
    async listCoupons() { await ensureSchema(); const [rows] = await pool.query("SELECT c.*, (SELECT COUNT(*) FROM pulso_coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM pulso_coupons c ORDER BY c.code"); return rows.map(coupon); },
    async getCoupon(code) { await ensureSchema(); const [[row]] = await pool.query("SELECT c.*, (SELECT COUNT(*) FROM pulso_coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM pulso_coupons c WHERE code=?", [code]); return coupon(row); },
    async saveCoupon(value) { await ensureSchema(); const existing = await this.getCoupon(value.code); const next = { id: existing?.id ?? id(), ...value }; await pool.query("INSERT INTO pulso_coupons (id,code,discount_bps,active,starts_at,ends_at,max_redemptions,product_scope_json) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE discount_bps=VALUES(discount_bps),active=VALUES(active),starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),max_redemptions=VALUES(max_redemptions),product_scope_json=VALUES(product_scope_json)", [next.id,next.code,next.discountBps,next.active?1:0,next.startsAt,next.endsAt,next.maxRedemptions,asJson(next.productSlugs)]); return this.getCoupon(next.code); },
    async getEligibleCoupon(code, slugs) { const c = await this.getCoupon(code); if (!c || !c.active || (c.startsAt && +new Date(c.startsAt)>Date.now()) || (c.endsAt && +new Date(c.endsAt)<=Date.now()) || (c.maxRedemptions!==null && c.redemptions>=c.maxRedemptions) || (c.productSlugs.length && !slugs.every((slug)=>c.productSlugs.includes(slug)))) return null; return c; },
    async beginCheckoutAttempt(key, fingerprint) { await ensureSchema(); try { await pool.query("INSERT INTO pulso_checkout_attempts (idempotency_key,fingerprint,state,expires_at) VALUES (?,?,'pending',DATE_ADD(NOW(3), INTERVAL 10 YEAR))", [key,fingerprint]); return { kind:"new" }; } catch (error) { if (error?.code !== "ER_DUP_ENTRY") throw error; const [[row]] = await pool.query("SELECT fingerprint,state,response_json AS response,expires_at FROM pulso_checkout_attempts WHERE idempotency_key=?", [key]); if (!row) return this.beginCheckoutAttempt(key,fingerprint); if(row.state==='complete'&&+new Date(row.expires_at)<=Date.now()){await pool.query("DELETE FROM pulso_checkout_attempts WHERE idempotency_key=? AND state='complete' AND expires_at<=NOW(3)",[key]);return this.beginCheckoutAttempt(key,fingerprint);} if (row.fingerprint !== fingerprint) return { kind:"conflict" }; const replay=fromJson(row.response,null); return row.state === "complete" && replay ? { kind:"replay", response:replay } : { kind:"pending" }; } },
    async completeCheckoutAttempt(key, response) { await ensureSchema(); await pool.query("UPDATE pulso_checkout_attempts SET state='complete',response_json=?,expires_at=DATE_ADD(NOW(3), INTERVAL 24 HOUR) WHERE idempotency_key=?", [JSON.stringify(response),key]); },
    async abandonCheckoutAttempt(key) { await ensureSchema(); await pool.query("DELETE FROM pulso_checkout_attempts WHERE idempotency_key=? AND state='pending'",[key]); },
    async reserveCoupon(code, attemptKey, slugs = []) { await ensureSchema(); const connection=await pool.getConnection(); try { await connection.beginTransaction(); await connection.query("DELETE FROM pulso_coupon_reservations WHERE expires_at<=NOW(3)"); const [[row]]=await connection.query("SELECT c.*, (SELECT COUNT(*) FROM pulso_coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM pulso_coupons c WHERE c.code=? FOR UPDATE",[code]); const c=coupon(row); if(!c||!c.active||(c.startsAt&&+new Date(c.startsAt)>Date.now())||(c.endsAt&&+new Date(c.endsAt)<=Date.now())||(c.productSlugs.length&&!slugs.every((slug)=>c.productSlugs.includes(slug)))){await connection.rollback();return null;} const [[reserved]]=await connection.query("SELECT COUNT(*) total FROM pulso_coupon_reservations WHERE coupon_code=? AND expires_at>NOW(3)",[code]); if(c.maxRedemptions!==null&&c.redemptions+Number(reserved.total)>=c.maxRedemptions){await connection.rollback();return null;} await connection.query("INSERT INTO pulso_coupon_reservations (attempt_key,coupon_code,expires_at) VALUES (?,?,DATE_ADD(NOW(3), INTERVAL 24 HOUR))",[attemptKey,code]); await connection.commit();return c;}catch(error){await connection.rollback();throw error;}finally{connection.release();} },
    async releaseCouponReservation(attemptKey) { await ensureSchema(); await pool.query("DELETE FROM pulso_coupon_reservations WHERE attempt_key=?",[attemptKey]); },
    async createOrder(order) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[existing]] = await connection.query(
          `SELECT id,status,coupon_redeemed FROM pulso_orders
           WHERE provider=? AND (provider_order_id=? OR (? IS NOT NULL AND provider_group_id=?))
           ORDER BY provider_order_id=? DESC,created_at ASC LIMIT 1 FOR UPDATE`,
          [
            order.provider,
            order.providerOrderId,
            order.providerGroupId ?? null,
            order.providerGroupId ?? null,
            order.providerOrderId,
          ],
        );
        const orderId = existing?.id ?? id();
        const status = resolveOrderStatus(existing?.status, order.status);
        if (existing) {
          await connection.query(
            "UPDATE pulso_orders SET provider_order_id=?,provider_group_id=?,status=?,buyer_email=?,buyer_cpf=?,buyer_name=?,buyer_phone=?,buyer_birth_date=?,buyer_address_json=?,payment_method=?,installments=?,installment_cents=?,subtotal_cents=?,discount_cents=?,total_cents=?,coupon_code=? WHERE id=?",
            [order.providerOrderId, order.providerGroupId ?? null, status, order.buyerEmail, order.buyerCpf ?? null, order.buyerName ?? null, order.buyerPhone ?? null, order.buyerBirthDate ?? null, order.buyerAddress ? JSON.stringify(order.buyerAddress) : null, order.paymentMethod ?? null, order.installments ?? null, order.installmentCents ?? null, order.subtotalCents, order.discountCents, order.totalCents, order.couponCode, orderId],
          );
          await connection.query("DELETE FROM pulso_order_items WHERE order_id=?", [orderId]);
        } else {
          await connection.query(
            "INSERT INTO pulso_orders (id,provider,provider_order_id,provider_group_id,status,buyer_email,buyer_cpf,buyer_name,buyer_phone,buyer_birth_date,buyer_address_json,payment_method,installments,installment_cents,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [orderId, order.provider, order.providerOrderId, order.providerGroupId ?? null, status, order.buyerEmail, order.buyerCpf ?? null, order.buyerName ?? null, order.buyerPhone ?? null, order.buyerBirthDate ?? null, order.buyerAddress ? JSON.stringify(order.buyerAddress) : null, order.paymentMethod ?? null, order.installments ?? null, order.installmentCents ?? null, order.subtotalCents, order.discountCents, order.totalCents, order.couponCode],
          );
        }
        for (const line of order.lines) {
          await connection.query(
            "INSERT INTO pulso_order_items (order_id,course_slug,title,base_price_cents,discount_cents,final_price_cents) VALUES (?,?,?,?,?,?)",
            [orderId, line.product.slug, line.product.title, line.basePriceCents, line.discountCents, line.finalPriceCents],
          );
        }
        if (order.checkoutAttemptKey) {
          const [bound] = await connection.query(
            "UPDATE pulso_coupon_reservations SET provider=?,provider_order_id=? WHERE attempt_key=?",
            [order.provider, order.providerOrderId, order.checkoutAttemptKey],
          );
          if (!bound.affectedRows) throw new Error("Coupon reservation is missing.");
        }
        if (status === "paid") {
          await connection.query(
            "UPDATE pulso_orders SET paid_cents=total_cents,paid_installments=1,access_granted_at=COALESCE(access_granted_at,NOW(3)) WHERE id=?",
            [orderId],
          );
        }
        if (status === "paid" && order.couponCode && !existing?.coupon_redeemed) {
          await connection.query("INSERT INTO pulso_coupon_redemptions (coupon_code,order_id) VALUES (?,?)", [order.couponCode, orderId]);
          await connection.query("UPDATE pulso_orders SET coupon_redeemed=1 WHERE id=?", [orderId]);
          await connection.query("DELETE FROM pulso_coupon_reservations WHERE attempt_key=?", [order.checkoutAttemptKey]);
        }
        await connection.commit();
        return { id: orderId, ...order, status };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async updateOrderFromWebhook({ provider, providerOrderId, providerGroupId, status, eventId }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (eventId) {
          const [seen] = await connection.query("SELECT event_id FROM pulso_webhook_events WHERE event_id=?", [eventId]);
          if (seen.length) {
            await connection.rollback();
            return { duplicate: true };
          }
        }
        let [[order]] = await connection.query(
          "SELECT * FROM pulso_orders WHERE provider=? AND provider_order_id=? FOR UPDATE",
          [provider, providerOrderId],
        );
        if (!order && providerGroupId) {
          [[order]] = await connection.query(
            "SELECT * FROM pulso_orders WHERE provider=? AND provider_group_id=? ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
            [provider, providerGroupId],
          );
        }
        const previousStatus = order?.status ?? null;
        if (!order) {
          const reconciledId = id();
          await connection.query(
            "INSERT INTO pulso_orders (id,provider,provider_order_id,provider_group_id,status,buyer_email,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,?,NULL,0,0,0,NULL)",
            [reconciledId, provider, providerOrderId, providerGroupId ?? null, status],
          );
          order = {
            id: reconciledId,
            status,
            coupon_code: null,
            coupon_redeemed: 0,
            provider_order_id: providerOrderId,
          };
        }
        const nextStatus = resolveOrderStatus(order.status, status);
        if (eventId) await connection.query("INSERT INTO pulso_webhook_events (event_id) VALUES (?)", [eventId]);
        await connection.query(
          `UPDATE pulso_orders SET status=?,
           paid_cents=CASE WHEN ?='paid' THEN total_cents ELSE paid_cents END,
           paid_installments=CASE WHEN ?='paid' THEN 1 ELSE paid_installments END,
           access_granted_at=CASE WHEN ?='paid' THEN COALESCE(access_granted_at,NOW(3)) ELSE access_granted_at END
           WHERE id=?`,
          [nextStatus, nextStatus, nextStatus, nextStatus, order.id],
        );
        if (nextStatus === "paid" && !order.coupon_redeemed && order.coupon_code) {
          const [[reservation]] = await connection.query(
            "SELECT attempt_key FROM pulso_coupon_reservations WHERE provider=? AND provider_order_id=? FOR UPDATE",
            [provider, order.provider_order_id],
          );
          if (!reservation) throw new Error("Paid order has no coupon reservation.");
          await connection.query("INSERT INTO pulso_coupon_redemptions (coupon_code,order_id) VALUES (?,?)", [order.coupon_code, order.id]);
          await connection.query("UPDATE pulso_orders SET coupon_redeemed=1 WHERE id=?", [order.id]);
          await connection.query("DELETE FROM pulso_coupon_reservations WHERE attempt_key=?", [reservation.attempt_key]);
        }
        if (["failed", "refunded", "chargeback"].includes(nextStatus)) {
          await connection.query(
            "DELETE FROM pulso_coupon_reservations WHERE provider=? AND provider_order_id=?",
            [provider, order.provider_order_id],
          );
        }
        await connection.commit();
        return { id: order.id, status: nextStatus, previousStatus };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async replacePaymentInstallments(orderId, providerGroupId, rows) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[order]] = await connection.query(
          "SELECT * FROM pulso_orders WHERE id=? AND provider='asaas' AND provider_group_id=? FOR UPDATE",
          [orderId, providerGroupId],
        );
        if (!order) throw new Error("Installment order was not found.");
        await connection.query("DELETE FROM pulso_payment_installments WHERE order_id=?", [orderId]);
        for (const row of rows) {
          await connection.query(
            `INSERT INTO pulso_payment_installments
             (id,order_id,provider,provider_payment_id,provider_group_id,installment_number,status,due_date,amount_cents,payment_url,paid_at)
             VALUES (?,?,'asaas',?,?,?,?,?,?,?,?)`,
            [
              id(),
              orderId,
              row.providerPaymentId,
              providerGroupId,
              row.number,
              row.status,
              row.dueDate,
              row.amountCents,
              row.paymentUrl,
              row.paidAt,
            ],
          );
        }
        const result = await reconcileInstallmentOrder(connection, order);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async listPaymentInstallments(orderId) {
      await ensureSchema();
      const [rows] = await pool.query(
        "SELECT * FROM pulso_payment_installments WHERE order_id=? ORDER BY installment_number",
        [orderId],
      );
      return rows.map(paymentInstallment);
    },
    async updatePaymentInstallmentFromWebhook({
      provider,
      providerOrderId,
      providerGroupId,
      installment,
      eventId,
    }) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        if (eventId) {
          const [created] = await connection.query(
            "INSERT IGNORE INTO pulso_webhook_events (event_id) VALUES (?)",
            [eventId],
          );
          if (!created.affectedRows) {
            await connection.rollback();
            return { duplicate: true };
          }
        }
        let [[order]] = await connection.query(
          `SELECT * FROM pulso_orders
           WHERE provider=? AND (provider_order_id=? OR provider_group_id=?)
           ORDER BY provider_order_id=? DESC,created_at ASC LIMIT 1 FOR UPDATE`,
          [provider, providerOrderId, providerGroupId, providerOrderId],
        );
        if (!order) {
          const reconciledId = id();
          await connection.query(
            `INSERT INTO pulso_orders
             (id,provider,provider_order_id,provider_group_id,status,buyer_email,subtotal_cents,discount_cents,total_cents)
             VALUES (?,?,?,?,?,NULL,0,0,0)`,
            [reconciledId, provider, providerOrderId, providerGroupId, "processing"],
          );
          [[order]] = await connection.query(
            "SELECT * FROM pulso_orders WHERE id=? FOR UPDATE",
            [reconciledId],
          );
        }
        await connection.query(
          `INSERT INTO pulso_payment_installments
           (id,order_id,provider,provider_payment_id,provider_group_id,installment_number,status,due_date,amount_cents,payment_url,paid_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE order_id=VALUES(order_id),provider_group_id=VALUES(provider_group_id),
           installment_number=VALUES(installment_number),status=VALUES(status),due_date=VALUES(due_date),
           amount_cents=VALUES(amount_cents),payment_url=VALUES(payment_url),paid_at=VALUES(paid_at)`,
          [
            id(),
            order.id,
            provider,
            installment.providerPaymentId,
            providerGroupId,
            installment.number,
            installment.status,
            installment.dueDate,
            installment.amountCents,
            installment.paymentUrl,
            installment.paidAt,
          ],
        );
        const result = await reconcileInstallmentOrder(connection, order);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
    async listOrders({ limit = 50, status } = {}) {
      await ensureSchema();
      const [rows] = await pool.query(`SELECT o.id,o.provider,o.provider_order_id AS providerOrderId,o.buyer_email AS buyerEmail,
        o.status,o.payment_method AS paymentMethod,o.installments,o.paid_installments AS paidInstallments,
        o.subtotal_cents AS subtotalCents,o.discount_cents AS discountCents,
        o.paid_cents AS paidCents,
        o.total_cents AS totalCents,o.coupon_code AS couponCode,
        (SELECT COUNT(*) FROM pulso_order_items i WHERE i.order_id=o.id) items,
        o.created_at AS createdAt,o.updated_at AS updatedAt
        FROM pulso_orders o ${status ? "WHERE o.status=?" : ""} ORDER BY o.updated_at DESC LIMIT ?`, status ? [status, limit] : [limit]);
      return rows.map((row) => ({
        ...row,
        subtotalCents: Number(row.subtotalCents),
        discountCents: Number(row.discountCents),
        totalCents: Number(row.totalCents),
        paidCents: Number(row.paidCents),
        installments: row.installments === null ? null : Number(row.installments),
        paidInstallments: Number(row.paidInstallments),
        items: Number(row.items),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }));
    },
    async getOrderWithItems(orderId) {
      await ensureSchema();
      const [[order]] = await pool.query("SELECT id,buyer_email,buyer_cpf,buyer_name,buyer_phone,buyer_birth_date,buyer_address_json FROM pulso_orders WHERE id=?", [orderId]);
      if (!order) return null;
      const [items] = await pool.query("SELECT id,course_slug,title FROM pulso_order_items WHERE order_id=? ORDER BY id", [orderId]);
      return {
        id: order.id,
        buyerEmail: order.buyer_email,
        buyerCpf: order.buyer_cpf,
        buyerName: order.buyer_name,
        buyerPhone: order.buyer_phone ?? null,
        buyerBirthDate: order.buyer_birth_date ?? null,
        buyerAddress: fromJson(order.buyer_address_json, null),
        items: items.map((item) => ({ id: item.id, courseSlug: item.course_slug, title: item.title })),
      };
    },
    async getOrderByProviderOrderId(provider, providerOrderId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT id,provider,provider_order_id AS providerOrderId,status,payment_method AS paymentMethod,
         installments,installment_cents AS installmentCents,total_cents AS totalCents
         FROM pulso_orders WHERE provider=? AND provider_order_id=? LIMIT 1`,
        [provider, providerOrderId],
      );
      return row ? {
        ...row,
        installments: Number(row.installments ?? 0),
        installmentCents: row.installmentCents === null ? null : Number(row.installmentCents),
        totalCents: Number(row.totalCents),
      } : null;
    },
  };
}
