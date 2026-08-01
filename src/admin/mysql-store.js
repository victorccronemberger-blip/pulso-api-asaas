import mysql from "mysql2/promise";
import { resolveOrderStatus } from "./order-status.js";
import { summarizeInstallmentPlan } from "../domain/payment-status.js";

const asJson = (value) => JSON.stringify(value ?? []);
const fromJson = (value, fallback = []) => {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const iso = (value) => value ? new Date(value).toISOString() : null;
const coupon = (row) => row && ({ id: row.id, code: row.code, discountBps: row.discount_bps, active: Boolean(row.active), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), maxRedemptions: row.max_redemptions, productSlugs: fromJson(row.product_scope_json), redemptions: Number(row.redemptions ?? 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
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
const enrollmentRow = (row) => row && ({ id: row.id, orderId: row.order_id, orderItemId: row.order_item_id, customerId: row.customer_id, courseSlug: row.course_slug, sourceTag: row.source_tag, status: row.status, attempts: Number(row.attempts), idTurma: row.id_turma, turmaSelection: row.turma_selection, userId: row.user_id, result: fromJson(row.result_json, null), error: row.error, buyerEmail: row.buyer_email, buyerCpf: row.buyer_cpf, buyerName: row.buyer_name, buyerBirthDate: row.buyer_birth_date ?? null, buyerAddress: fromJson(row.buyer_address_json, null), buyerPhone: row.buyer_phone ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

export function createMySqlStore(databaseUrl) {
  const pool = mysql.createPool({ uri: databaseUrl, timezone: "Z", dateStrings: true });
  let ready;
  async function ensureSchema() {
    if (ready) return ready;
    ready = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS administrators (id CHAR(36) PRIMARY KEY, email VARCHAR(160) NOT NULL UNIQUE, password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS admin_sessions (id CHAR(36) PRIMARY KEY, admin_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, csrf_hash CHAR(64) NOT NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX admin_sessions_expiry (expires_at), CONSTRAINT admin_sessions_admin_fk FOREIGN KEY (admin_id) REFERENCES administrators(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS customers (id CHAR(36) PRIMARY KEY, email VARCHAR(160) NOT NULL UNIQUE, display_name VARCHAR(120) NOT NULL, mobile_phone VARCHAR(16) NULL, document_last4 CHAR(4) NULL, email_verified_at DATETIME(3) NULL, password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS customer_sessions (id CHAR(36) PRIMARY KEY, customer_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, csrf_hash CHAR(64) NOT NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX customer_sessions_expiry (expires_at), CONSTRAINT customer_sessions_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS customer_action_tokens (id CHAR(36) PRIMARY KEY, customer_id CHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX customer_action_customer_kind (customer_id, kind), INDEX customer_action_expiry (expires_at), CONSTRAINT customer_action_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS products (slug VARCHAR(80) PRIMARY KEY, source_tag VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, description TEXT NOT NULL, category_id VARCHAR(60) NOT NULL, kind VARCHAR(32) NOT NULL, accent CHAR(7) NULL, cohort VARCHAR(40) NULL, course_year VARCHAR(8) NULL, official_price_cents INT UNSIGNED NOT NULL, price_cents INT UNSIGNED NOT NULL, featured TINYINT(1) NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, image_url VARCHAR(500) NULL, image_600_url VARCHAR(500) NULL, image_alt VARCHAR(255) NULL, keywords_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX products_active_order (active,sort_order,title), UNIQUE INDEX products_source_tag (source_tag))`,
        `CREATE TABLE IF NOT EXISTS coupons (id CHAR(36) PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, discount_bps SMALLINT UNSIGNED NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, starts_at DATETIME(3) NULL, ends_at DATETIME(3) NULL, max_redemptions INT UNSIGNED NULL, product_scope_json JSON NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX coupons_active (active, starts_at, ends_at))`,
        `CREATE TABLE IF NOT EXISTS orders (id CHAR(36) PRIMARY KEY, provider VARCHAR(24) NOT NULL, provider_order_id VARCHAR(80) NOT NULL, provider_group_id VARCHAR(80) NULL, status VARCHAR(32) NOT NULL, buyer_email VARCHAR(160) NULL, buyer_cpf VARCHAR(14) NULL, buyer_name VARCHAR(180) NULL, buyer_phone VARCHAR(13) NULL, customer_id CHAR(36) NULL, payment_method VARCHAR(24) NULL, installments TINYINT UNSIGNED NULL, installment_cents INT UNSIGNED NULL, subtotal_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, total_cents INT UNSIGNED NOT NULL, paid_cents INT UNSIGNED NOT NULL DEFAULT 0, paid_installments TINYINT UNSIGNED NOT NULL DEFAULT 0, access_granted_at DATETIME(3) NULL, coupon_code VARCHAR(32) NULL, coupon_redeemed TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX orders_provider_order (provider, provider_order_id), INDEX orders_provider_group (provider, provider_group_id), INDEX orders_status_updated (status, updated_at), INDEX orders_customer_updated (customer_id, updated_at))`,
        `CREATE TABLE IF NOT EXISTS order_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL, course_slug VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, base_price_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, final_price_cents INT UNSIGNED NOT NULL, CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS payment_installments (id CHAR(36) PRIMARY KEY, order_id CHAR(36) NOT NULL, provider VARCHAR(24) NOT NULL DEFAULT 'asaas', provider_payment_id VARCHAR(80) NOT NULL, provider_group_id VARCHAR(80) NOT NULL, installment_number TINYINT UNSIGNED NOT NULL, status VARCHAR(24) NOT NULL, due_date DATE NULL, amount_cents INT UNSIGNED NOT NULL DEFAULT 0, payment_url VARCHAR(500) NULL, paid_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX payment_installments_provider_payment (provider, provider_payment_id), UNIQUE INDEX payment_installments_order_number (order_id, installment_number), INDEX payment_installments_order_status (order_id, status, due_date), CONSTRAINT payment_installments_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS coupon_redemptions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, order_id CHAR(36) NOT NULL UNIQUE, redeemed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX coupon_redemptions_code (coupon_code))`,
        `CREATE TABLE IF NOT EXISTS coupon_reservations (attempt_key CHAR(36) PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, provider VARCHAR(24) NULL, provider_order_id VARCHAR(80) NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX coupon_reservations_provider_order (provider, provider_order_id), INDEX coupon_reservations_code_expiry (coupon_code, expires_at))`,
        `CREATE TABLE IF NOT EXISTS checkout_attempts (idempotency_key CHAR(36) PRIMARY KEY, fingerprint CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, response_json JSON NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX checkout_attempts_expiry (expires_at))`,
        `CREATE TABLE IF NOT EXISTS webhook_events (event_id VARCHAR(128) PRIMARY KEY, received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS admin_audit_log (id CHAR(36) PRIMARY KEY, admin_id CHAR(36) NULL, action VARCHAR(80) NOT NULL, entity_type VARCHAR(80) NOT NULL, entity_id VARCHAR(80) NULL, metadata_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX audit_created (created_at))`,
        `CREATE TABLE IF NOT EXISTS app_settings (setting_key VARCHAR(64) PRIMARY KEY, setting_value JSON NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS enrollments (id CHAR(36) PRIMARY KEY, order_id CHAR(36) NULL, order_item_id BIGINT UNSIGNED NULL, customer_id CHAR(36) NULL, course_slug VARCHAR(80) NOT NULL, source_tag VARCHAR(80) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'queued', attempts INT UNSIGNED NOT NULL DEFAULT 0, id_turma INT NULL, turma_selection VARCHAR(40) NULL, user_id VARCHAR(80) NULL, result_json JSON NULL, error VARCHAR(512) NULL, buyer_email VARCHAR(160) NULL, buyer_cpf VARCHAR(14) NULL, buyer_name VARCHAR(180) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX enrollments_order_course (order_id, course_slug), INDEX enrollments_customer_course (customer_id, course_slug), INDEX enrollments_status (status, created_at), CONSTRAINT enrollments_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE)`,
      ];
      for (const sql of statements) await pool.query(sql);
      const [productColumns] = await pool.query("SHOW COLUMNS FROM products");
      const productColumnNames = new Set(productColumns.map((column) => column.Field));
      if (!productColumnNames.has("image_url")) await pool.query("ALTER TABLE products ADD COLUMN image_url VARCHAR(500) NULL AFTER sort_order");
      if (!productColumnNames.has("image_600_url")) await pool.query("ALTER TABLE products ADD COLUMN image_600_url VARCHAR(500) NULL AFTER image_url");
      if (!productColumnNames.has("image_alt")) await pool.query("ALTER TABLE products ADD COLUMN image_alt VARCHAR(255) NULL AFTER image_600_url");
      const [customerColumns] = await pool.query("SHOW COLUMNS FROM customers");
      const customerColumnNames = new Set(customerColumns.map((column) => column.Field));
      if (!customerColumnNames.has("email_verified_at")) await pool.query("ALTER TABLE customers ADD COLUMN email_verified_at DATETIME(3) NULL AFTER document_last4");
      const [orderColumns] = await pool.query("SHOW COLUMNS FROM orders");
      const orderColumnNames = new Set(orderColumns.map((column) => column.Field));
      if (!orderColumnNames.has("provider")) await pool.query("ALTER TABLE orders ADD COLUMN provider VARCHAR(24) NULL AFTER id");
      if (!orderColumnNames.has("provider_order_id")) await pool.query("ALTER TABLE orders ADD COLUMN provider_order_id VARCHAR(80) NULL AFTER provider");
      if (!orderColumnNames.has("provider_group_id")) await pool.query("ALTER TABLE orders ADD COLUMN provider_group_id VARCHAR(80) NULL AFTER provider_order_id");
      if (!orderColumnNames.has("buyer_cpf")) await pool.query("ALTER TABLE orders ADD COLUMN buyer_cpf VARCHAR(14) NULL AFTER buyer_email");
      if (!orderColumnNames.has("buyer_name")) await pool.query("ALTER TABLE orders ADD COLUMN buyer_name VARCHAR(180) NULL AFTER buyer_cpf");
      if (!orderColumnNames.has("buyer_phone")) await pool.query("ALTER TABLE orders ADD COLUMN buyer_phone VARCHAR(13) NULL AFTER buyer_name");
      if (!orderColumnNames.has("customer_id")) await pool.query("ALTER TABLE orders ADD COLUMN customer_id CHAR(36) NULL AFTER buyer_phone");
      if (!orderColumnNames.has("payment_method")) await pool.query("ALTER TABLE orders ADD COLUMN payment_method VARCHAR(24) NULL AFTER customer_id");
      if (!orderColumnNames.has("installments")) await pool.query("ALTER TABLE orders ADD COLUMN installments TINYINT UNSIGNED NULL AFTER payment_method");
      if (!orderColumnNames.has("installment_cents")) await pool.query("ALTER TABLE orders ADD COLUMN installment_cents INT UNSIGNED NULL AFTER installments");
      if (!orderColumnNames.has("paid_cents")) await pool.query("ALTER TABLE orders ADD COLUMN paid_cents INT UNSIGNED NOT NULL DEFAULT 0 AFTER total_cents");
      if (!orderColumnNames.has("paid_installments")) await pool.query("ALTER TABLE orders ADD COLUMN paid_installments TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER paid_cents");
      if (!orderColumnNames.has("access_granted_at")) await pool.query("ALTER TABLE orders ADD COLUMN access_granted_at DATETIME(3) NULL AFTER paid_installments");
      // Dados completos do comprador coletados no checkout (nascimento + endereco
      // completo). Alimentam o perfil do aluno na plataforma de cursos — sem eles
      // a matrícula caía em defaults fabricados e colidia com perfis antigos.
      if (!orderColumnNames.has("buyer_birth_date")) await pool.query("ALTER TABLE orders ADD COLUMN buyer_birth_date VARCHAR(10) NULL AFTER buyer_phone");
      if (!orderColumnNames.has("buyer_address_json")) await pool.query("ALTER TABLE orders ADD COLUMN buyer_address_json JSON NULL AFTER buyer_birth_date");
      await pool.query("UPDATE orders SET paid_cents=total_cents,paid_installments=1,access_granted_at=COALESCE(access_granted_at,updated_at) WHERE status='paid' AND paid_cents=0");
      if (orderColumnNames.has("appmax_order_id")) {
        await pool.query("ALTER TABLE orders MODIFY appmax_order_id BIGINT UNSIGNED NULL");
        await pool.query("UPDATE orders SET provider='appmax', provider_order_id=CAST(appmax_order_id AS CHAR) WHERE provider_order_id IS NULL AND appmax_order_id IS NOT NULL");
      }
      await pool.query("ALTER TABLE orders MODIFY provider VARCHAR(24) NOT NULL, MODIFY provider_order_id VARCHAR(80) NOT NULL");
      const [orderIndexes] = await pool.query("SHOW INDEX FROM orders WHERE Key_name='orders_provider_order'");
      if (!orderIndexes.length) await pool.query("ALTER TABLE orders ADD UNIQUE INDEX orders_provider_order (provider, provider_order_id)");
      const [orderGroupIndexes] = await pool.query("SHOW INDEX FROM orders WHERE Key_name='orders_provider_group'");
      if (!orderGroupIndexes.length) await pool.query("ALTER TABLE orders ADD INDEX orders_provider_group (provider, provider_group_id)");
      const [orderCustomerIndexes] = await pool.query("SHOW INDEX FROM orders WHERE Key_name='orders_customer_updated'");
      if (!orderCustomerIndexes.length) await pool.query("ALTER TABLE orders ADD INDEX orders_customer_updated (customer_id, updated_at)");

      const [reservationColumns] = await pool.query("SHOW COLUMNS FROM coupon_reservations");
      const reservationColumnNames = new Set(reservationColumns.map((column) => column.Field));
      if (!reservationColumnNames.has("provider")) await pool.query("ALTER TABLE coupon_reservations ADD COLUMN provider VARCHAR(24) NULL AFTER coupon_code");
      if (!reservationColumnNames.has("provider_order_id")) await pool.query("ALTER TABLE coupon_reservations ADD COLUMN provider_order_id VARCHAR(80) NULL AFTER provider");
      if (reservationColumnNames.has("appmax_order_id")) {
        await pool.query("UPDATE coupon_reservations SET provider='appmax', provider_order_id=CAST(appmax_order_id AS CHAR) WHERE provider_order_id IS NULL AND appmax_order_id IS NOT NULL");
      }
      const [reservationIndexes] = await pool.query("SHOW INDEX FROM coupon_reservations WHERE Key_name='coupon_reservations_provider_order'");
      if (!reservationIndexes.length) await pool.query("ALTER TABLE coupon_reservations ADD UNIQUE INDEX coupon_reservations_provider_order (provider, provider_order_id)");
      const [[catalogMigration]] = await pool.query(
        "SELECT setting_key FROM app_settings WHERE setting_key='catalog-half-price-v1'",
      );
      if (!catalogMigration) {
        await pool.query("UPDATE coupons SET active=0 WHERE code='PULSO35'");
        await pool.query(
          "INSERT INTO app_settings (setting_key, setting_value) VALUES ('campaign', JSON_OBJECT('activeCouponCode', NULL, 'headline', NULL)) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
        );
        await pool.query(
          "INSERT INTO app_settings (setting_key, setting_value) VALUES ('catalog-half-price-v1', JSON_OBJECT('appliedAt', NOW(3)))",
        );
      }
      await pool.query(
        "INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('campaign', JSON_OBJECT('activeCouponCode', NULL, 'headline', NULL))",
      );
      const [enrollmentColumns] = await pool.query("SHOW COLUMNS FROM enrollments");
      const enrollmentColumnNames = new Set(enrollmentColumns.map((column) => column.Field));
      if (!enrollmentColumnNames.has("buyer_birth_date")) await pool.query("ALTER TABLE enrollments ADD COLUMN buyer_birth_date VARCHAR(10) NULL AFTER buyer_name");
      if (!enrollmentColumnNames.has("buyer_address_json")) await pool.query("ALTER TABLE enrollments ADD COLUMN buyer_address_json JSON NULL AFTER buyer_birth_date");
      if (!enrollmentColumnNames.has("buyer_phone")) await pool.query("ALTER TABLE enrollments ADD COLUMN buyer_phone VARCHAR(13) NULL AFTER buyer_address_json");
      const orderIdColumn = enrollmentColumns.find((column) => column.Field === "order_id");
      if (orderIdColumn?.Null === "NO") await pool.query("ALTER TABLE enrollments MODIFY order_id CHAR(36) NULL");
      if (!enrollmentColumnNames.has("customer_id")) await pool.query("ALTER TABLE enrollments ADD COLUMN customer_id CHAR(36) NULL AFTER order_item_id");
      await pool.query("UPDATE enrollments e JOIN orders o ON o.id=e.order_id SET e.customer_id=o.customer_id WHERE e.customer_id IS NULL AND o.customer_id IS NOT NULL");
      const [enrollmentCustomerIndexes] = await pool.query("SHOW INDEX FROM enrollments WHERE Key_name='enrollments_customer_course'");
      if (!enrollmentCustomerIndexes.length) await pool.query("ALTER TABLE enrollments ADD INDEX enrollments_customer_course (customer_id, course_slug)");
    })();
    return ready;
  }
  const id = () => crypto.randomUUID();

  async function redeemCoupon(connection, order) {
    if (!order.coupon_code || order.coupon_redeemed) return;
    const [[reservation]] = await connection.query(
      "SELECT attempt_key FROM coupon_reservations WHERE provider=? AND provider_order_id=? FOR UPDATE",
      [order.provider, order.provider_order_id],
    );
    if (!reservation) throw new Error("Paid order has no coupon reservation.");
    await connection.query(
      "INSERT IGNORE INTO coupon_redemptions (coupon_code,order_id) VALUES (?,?)",
      [order.coupon_code, order.id],
    );
    await connection.query("UPDATE orders SET coupon_redeemed=1 WHERE id=?", [order.id]);
    await connection.query(
      "DELETE FROM coupon_reservations WHERE attempt_key=?",
      [reservation.attempt_key],
    );
  }

  async function reconcileInstallmentOrder(connection, order) {
    const [storedRows] = await connection.query(
      "SELECT * FROM payment_installments WHERE order_id=? ORDER BY installment_number",
      [order.id],
    );
    const summary = summarizeInstallmentPlan(
      storedRows.map(paymentInstallment),
      Number(order.installments ?? 0),
    );
    const hadAccess = Boolean(order.access_granted_at);
    await connection.query(
      `UPDATE orders SET status=?,paid_cents=?,paid_installments=?,
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
    ensureSchema, async close() { await pool.end(); },
    async countAdmins() { await ensureSchema(); const [[row]] = await pool.query("SELECT COUNT(*) AS total FROM administrators"); return Number(row.total); },
    async listCatalogProducts({ activeOnly = true } = {}) {
      await ensureSchema();
      const [rows] = await pool.query(`SELECT slug,source_tag AS sourceTag,title,description,category_id AS categoryId,kind,accent,cohort,course_year AS year,official_price_cents AS officialPriceCents,price_cents AS priceCents,featured,active,sort_order AS sortOrder,image_url AS imageUrl,image_600_url AS image600Url,image_alt AS imageAlt,keywords_json AS keywordsJson FROM products ${activeOnly ? "WHERE active=1" : ""} ORDER BY sort_order ASC,title ASC`);
      return rows.map((row) => ({ ...row, officialPriceCents: Number(row.officialPriceCents), priceCents: Number(row.priceCents), featured: Boolean(row.featured), active: Boolean(row.active), keywords: fromJson(row.keywordsJson, []) }));
    },
    async getAdminByEmail(email) { await ensureSchema(); const [[row]] = await pool.query("SELECT id, email, password_salt AS passwordSalt, password_hash AS passwordHash FROM administrators WHERE email = ?", [email]); return row ?? null; },
    async createAdmin(admin) { await ensureSchema(); const value = { id: id(), ...admin }; await pool.query("INSERT INTO administrators (id,email,password_salt,password_hash) VALUES (?,?,?,?)", [value.id,value.email,value.passwordSalt,value.passwordHash]); return value; },
    async createSession(session) { await ensureSchema(); await pool.query("INSERT INTO admin_sessions (id,admin_id,token_hash,csrf_hash,expires_at) VALUES (?,?,?,?,?)", [id(),session.adminId,session.tokenHash,session.csrfHash,new Date(session.expiresAt)]); },
    async getSession(tokenHash) { await ensureSchema(); const [[row]] = await pool.query("SELECT s.id,s.admin_id AS adminId,s.csrf_hash AS csrfHash,s.expires_at AS expiresAt,a.email FROM admin_sessions s JOIN administrators a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at > NOW(3)", [tokenHash]); return row ? { ...row, expiresAt: +new Date(row.expiresAt), admin: { id: row.adminId, email: row.email } } : null; },
    async revokeSession(tokenHash) { await ensureSchema(); await pool.query("DELETE FROM admin_sessions WHERE token_hash=?", [tokenHash]); },
    async getCustomerByEmail(email) { await ensureSchema(); const [[row]] = await pool.query("SELECT id,email,display_name AS displayName,mobile_phone AS mobilePhone,document_last4 AS documentLast4,email_verified_at AS emailVerifiedAt,password_salt AS passwordSalt,password_hash AS passwordHash,created_at AS createdAt FROM customers WHERE email=?", [email]); return row ? { ...row, emailVerifiedAt:iso(row.emailVerifiedAt), createdAt: iso(row.createdAt) } : null; },
    async getCustomerById(customerId) { await ensureSchema(); const [[row]] = await pool.query("SELECT id,email,display_name AS displayName,mobile_phone AS mobilePhone,document_last4 AS documentLast4,email_verified_at AS emailVerifiedAt,created_at AS createdAt FROM customers WHERE id=?", [customerId]); return row ? { ...row, emailVerifiedAt:iso(row.emailVerifiedAt), createdAt:iso(row.createdAt) } : null; },
    async listCustomers({limit=100}={}) {
      await ensureSchema();
      const [rows]=await pool.query(
        `SELECT c.id,c.email,c.display_name AS displayName,c.mobile_phone AS mobilePhone,
         c.document_last4 AS documentLast4,c.email_verified_at AS emailVerifiedAt,c.created_at AS createdAt,
         (SELECT COUNT(*) FROM enrollments e WHERE e.customer_id=c.id AND e.status='confirmed') AS activationCount
         FROM customers c ORDER BY c.created_at DESC LIMIT ?`,
        [limit],
      );
      return rows.map((row)=>({
        ...row,
        emailVerifiedAt:iso(row.emailVerifiedAt),
        createdAt:iso(row.createdAt),
        activationCount:Number(row.activationCount),
      }));
    },
    async createCustomer(customer) { await ensureSchema(); const value={id:id(),...customer}; await pool.query("INSERT INTO customers (id,email,display_name,password_salt,password_hash) VALUES (?,?,?,?,?)",[value.id,value.email,value.displayName,value.passwordSalt,value.passwordHash]); return { ...value, mobilePhone:null, documentLast4:null, emailVerifiedAt:null, createdAt:new Date().toISOString() }; },
    async updateCustomerProfile(customerId, profile) { await ensureSchema(); await pool.query("UPDATE customers SET display_name=COALESCE(?,display_name),mobile_phone=?,document_last4=COALESCE(?,document_last4) WHERE id=?",[profile.displayName ?? null,profile.mobilePhone ?? null,profile.documentLast4 ?? null,customerId]); const [[row]]=await pool.query("SELECT id,email,display_name AS displayName,mobile_phone AS mobilePhone,document_last4 AS documentLast4,email_verified_at AS emailVerifiedAt,created_at AS createdAt FROM customers WHERE id=?",[customerId]); return row ? { ...row,emailVerifiedAt:iso(row.emailVerifiedAt),createdAt:iso(row.createdAt) } : null; },
    async updateCustomerPassword(customerId, credentials) { await ensureSchema(); const [result]=await pool.query("UPDATE customers SET password_salt=?,password_hash=? WHERE id=?",[credentials.passwordSalt,credentials.passwordHash,customerId]); return result.affectedRows>0; },
    async markCustomerEmailVerified(customerId) { await ensureSchema(); await pool.query("UPDATE customers SET email_verified_at=COALESCE(email_verified_at,NOW(3)) WHERE id=?",[customerId]); const [[row]]=await pool.query("SELECT id,email,display_name AS displayName,mobile_phone AS mobilePhone,document_last4 AS documentLast4,email_verified_at AS emailVerifiedAt,created_at AS createdAt FROM customers WHERE id=?",[customerId]); return row ? { ...row,emailVerifiedAt:iso(row.emailVerifiedAt),createdAt:iso(row.createdAt) } : null; },
    async createCustomerActionToken(value) { await ensureSchema(); const connection=await pool.getConnection(); try { await connection.beginTransaction(); await connection.query("DELETE FROM customer_action_tokens WHERE customer_id=? AND kind=?",[value.customerId,value.kind]); await connection.query("INSERT INTO customer_action_tokens (id,customer_id,kind,token_hash,expires_at) VALUES (?,?,?,?,?)",[id(),value.customerId,value.kind,value.tokenHash,new Date(value.expiresAt)]); await connection.commit(); } catch(error) { await connection.rollback(); throw error; } finally { connection.release(); } },
    async consumeCustomerActionToken(value) { await ensureSchema(); const connection=await pool.getConnection(); try { await connection.beginTransaction(); const [[row]]=await connection.query("SELECT id,customer_id AS customerId,kind,expires_at AS expiresAt FROM customer_action_tokens WHERE token_hash=? AND kind=? AND expires_at>NOW(3) FOR UPDATE",[value.tokenHash,value.kind]); if(!row){await connection.rollback();return null;} await connection.query("DELETE FROM customer_action_tokens WHERE id=?",[row.id]); await connection.commit(); return { ...row,expiresAt:+new Date(row.expiresAt) }; } catch(error) { await connection.rollback(); throw error; } finally { connection.release(); } },
    async createCustomerSession(session) { await ensureSchema(); await pool.query("INSERT INTO customer_sessions (id,customer_id,token_hash,csrf_hash,expires_at) VALUES (?,?,?,?,?)",[id(),session.customerId,session.tokenHash,session.csrfHash,new Date(session.expiresAt)]); },
    async getCustomerSession(tokenHash) { await ensureSchema(); const [[row]]=await pool.query("SELECT s.id,s.customer_id AS customerId,s.csrf_hash AS csrfHash,s.expires_at AS expiresAt,c.email,c.display_name AS displayName,c.mobile_phone AS mobilePhone,c.document_last4 AS documentLast4,c.email_verified_at AS emailVerifiedAt,c.created_at AS customerCreatedAt FROM customer_sessions s JOIN customers c ON c.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>NOW(3)",[tokenHash]); return row ? { id:row.id,customerId:row.customerId,csrfHash:row.csrfHash,expiresAt:+new Date(row.expiresAt),customer:{id:row.customerId,email:row.email,displayName:row.displayName,mobilePhone:row.mobilePhone,documentLast4:row.documentLast4,emailVerifiedAt:iso(row.emailVerifiedAt),createdAt:iso(row.customerCreatedAt)} } : null; },
    async revokeCustomerSession(tokenHash) { await ensureSchema(); await pool.query("DELETE FROM customer_sessions WHERE token_hash=?",[tokenHash]); },
    async revokeCustomerSessions(customerId) { await ensureSchema(); await pool.query("DELETE FROM customer_sessions WHERE customer_id=?",[customerId]); },
    async listCoupons() { await ensureSchema(); const [rows] = await pool.query("SELECT c.*, (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM coupons c ORDER BY c.code"); return rows.map(coupon); },
    async getCoupon(code) { await ensureSchema(); const [[row]] = await pool.query("SELECT c.*, (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM coupons c WHERE code=?", [code]); return coupon(row); },
    async saveCoupon(value) { await ensureSchema(); const existing = await this.getCoupon(value.code); const next = { id: existing?.id ?? id(), ...value }; await pool.query("INSERT INTO coupons (id,code,discount_bps,active,starts_at,ends_at,max_redemptions,product_scope_json) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE discount_bps=VALUES(discount_bps),active=VALUES(active),starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),max_redemptions=VALUES(max_redemptions),product_scope_json=VALUES(product_scope_json)", [next.id,next.code,next.discountBps,next.active?1:0,next.startsAt,next.endsAt,next.maxRedemptions,asJson(next.productSlugs)]); return this.getCoupon(next.code); },
    async archiveCoupon(code) { await ensureSchema(); const [result] = await pool.query("UPDATE coupons SET active=0 WHERE code=?", [code]); if (result.affectedRows) { const current = await this.getCampaign(); if (current.activeCouponCode === code) await this.saveCampaign({ activeCouponCode: null }); } return Boolean(result.affectedRows); },
    async getEligibleCoupon(code, slugs) { const c = await this.getCoupon(code); if (!c || !c.active || (c.startsAt && +new Date(c.startsAt)>Date.now()) || (c.endsAt && +new Date(c.endsAt)<=Date.now()) || (c.maxRedemptions!==null && c.redemptions>=c.maxRedemptions) || (c.productSlugs.length && !slugs.every((slug)=>c.productSlugs.includes(slug)))) return null; return c; },
    async beginCheckoutAttempt(key, fingerprint) { await ensureSchema(); try { await pool.query("INSERT INTO checkout_attempts (idempotency_key,fingerprint,state,expires_at) VALUES (?,?,'pending',DATE_ADD(NOW(3), INTERVAL 10 YEAR))", [key,fingerprint]); return { kind:"new" }; } catch (error) { if (error?.code !== "ER_DUP_ENTRY") throw error; const [[row]] = await pool.query("SELECT fingerprint,state,response_json AS response,expires_at FROM checkout_attempts WHERE idempotency_key=?", [key]); if (!row) return this.beginCheckoutAttempt(key,fingerprint); if(row.state==='complete'&&+new Date(row.expires_at)<=Date.now()){await pool.query("DELETE FROM checkout_attempts WHERE idempotency_key=? AND state='complete' AND expires_at<=NOW(3)",[key]);return this.beginCheckoutAttempt(key,fingerprint);} if (row.fingerprint !== fingerprint) return { kind:"conflict" }; const replay=fromJson(row.response,null); return row.state === "complete" && replay ? { kind:"replay", response:replay } : { kind:"pending" }; } },
    async completeCheckoutAttempt(key, response) { await ensureSchema(); await pool.query("UPDATE checkout_attempts SET state='complete',response_json=?,expires_at=DATE_ADD(NOW(3), INTERVAL 24 HOUR) WHERE idempotency_key=?", [JSON.stringify(response),key]); },
    async abandonCheckoutAttempt(key) { await ensureSchema(); await pool.query("DELETE FROM checkout_attempts WHERE idempotency_key=? AND state='pending'",[key]); },
    async reserveCoupon(code, attemptKey, slugs = []) { await ensureSchema(); const connection=await pool.getConnection(); try { await connection.beginTransaction(); await connection.query("DELETE FROM coupon_reservations WHERE expires_at<=NOW(3)"); const [[row]]=await connection.query("SELECT c.*, (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_code=c.code) redemptions FROM coupons c WHERE c.code=? FOR UPDATE",[code]); const c=coupon(row); if(!c||!c.active||(c.startsAt&&+new Date(c.startsAt)>Date.now())||(c.endsAt&&+new Date(c.endsAt)<=Date.now())||(c.productSlugs.length&&!slugs.every((slug)=>c.productSlugs.includes(slug)))){await connection.rollback();return null;} const [[reserved]]=await connection.query("SELECT COUNT(*) total FROM coupon_reservations WHERE coupon_code=? AND expires_at>NOW(3)",[code]); if(c.maxRedemptions!==null&&c.redemptions+Number(reserved.total)>=c.maxRedemptions){await connection.rollback();return null;} await connection.query("INSERT INTO coupon_reservations (attempt_key,coupon_code,expires_at) VALUES (?,?,DATE_ADD(NOW(3), INTERVAL 24 HOUR))",[attemptKey,code]); await connection.commit();return c;}catch(error){await connection.rollback();throw error;}finally{connection.release();} },
    async releaseCouponReservation(attemptKey) { await ensureSchema(); await pool.query("DELETE FROM coupon_reservations WHERE attempt_key=?",[attemptKey]); },
    async createOrder(order) {
      await ensureSchema();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[existing]] = await connection.query(
          `SELECT id,status,coupon_redeemed FROM orders
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
            "UPDATE orders SET provider_order_id=?,provider_group_id=?,status=?,buyer_email=?,buyer_cpf=?,buyer_name=?,buyer_phone=?,buyer_birth_date=?,buyer_address_json=?,customer_id=?,payment_method=?,installments=?,installment_cents=?,subtotal_cents=?,discount_cents=?,total_cents=?,coupon_code=? WHERE id=?",
            [order.providerOrderId, order.providerGroupId ?? null, status, order.buyerEmail, order.buyerCpf ?? null, order.buyerName ?? null, order.buyerPhone ?? null, order.buyerBirthDate ?? null, order.buyerAddress ? JSON.stringify(order.buyerAddress) : null, order.customerId ?? null, order.paymentMethod ?? null, order.installments ?? null, order.installmentCents ?? null, order.subtotalCents, order.discountCents, order.totalCents, order.couponCode, orderId],
          );
          await connection.query("DELETE FROM order_items WHERE order_id=?", [orderId]);
        } else {
          await connection.query(
            "INSERT INTO orders (id,provider,provider_order_id,provider_group_id,status,buyer_email,buyer_cpf,buyer_name,buyer_phone,buyer_birth_date,buyer_address_json,customer_id,payment_method,installments,installment_cents,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [orderId, order.provider, order.providerOrderId, order.providerGroupId ?? null, status, order.buyerEmail, order.buyerCpf ?? null, order.buyerName ?? null, order.buyerPhone ?? null, order.buyerBirthDate ?? null, order.buyerAddress ? JSON.stringify(order.buyerAddress) : null, order.customerId ?? null, order.paymentMethod ?? null, order.installments ?? null, order.installmentCents ?? null, order.subtotalCents, order.discountCents, order.totalCents, order.couponCode],
          );
        }
        for (const line of order.lines) {
          await connection.query(
            "INSERT INTO order_items (order_id,course_slug,title,base_price_cents,discount_cents,final_price_cents) VALUES (?,?,?,?,?,?)",
            [orderId, line.product.slug, line.product.title, line.basePriceCents, line.discountCents, line.finalPriceCents],
          );
        }
        if (order.checkoutAttemptKey) {
          const [bound] = await connection.query(
            "UPDATE coupon_reservations SET provider=?,provider_order_id=? WHERE attempt_key=?",
            [order.provider, order.providerOrderId, order.checkoutAttemptKey],
          );
          if (!bound.affectedRows) throw new Error("Coupon reservation is missing.");
        }
        if (status === "paid") {
          await connection.query(
            "UPDATE orders SET paid_cents=total_cents,paid_installments=1,access_granted_at=COALESCE(access_granted_at,NOW(3)) WHERE id=?",
            [orderId],
          );
        }
        if (status === "paid" && order.couponCode && !existing?.coupon_redeemed) {
          await connection.query("INSERT INTO coupon_redemptions (coupon_code,order_id) VALUES (?,?)", [order.couponCode, orderId]);
          await connection.query("UPDATE orders SET coupon_redeemed=1 WHERE id=?", [orderId]);
          await connection.query("DELETE FROM coupon_reservations WHERE attempt_key=?", [order.checkoutAttemptKey]);
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
          const [seen] = await connection.query("SELECT event_id FROM webhook_events WHERE event_id=?", [eventId]);
          if (seen.length) {
            await connection.rollback();
            return { duplicate: true };
          }
        }
        let [[order]] = await connection.query(
          "SELECT * FROM orders WHERE provider=? AND provider_order_id=? FOR UPDATE",
          [provider, providerOrderId],
        );
        if (!order && providerGroupId) {
          [[order]] = await connection.query(
            "SELECT * FROM orders WHERE provider=? AND provider_group_id=? ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
            [provider, providerGroupId],
          );
        }
        const previousStatus = order?.status ?? null;
        if (!order) {
          const reconciledId = id();
          await connection.query(
            "INSERT INTO orders (id,provider,provider_order_id,provider_group_id,status,buyer_email,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,?,NULL,0,0,0,NULL)",
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
        if (eventId) await connection.query("INSERT INTO webhook_events (event_id) VALUES (?)", [eventId]);
        await connection.query(
          `UPDATE orders SET status=?,
           paid_cents=CASE WHEN ?='paid' THEN total_cents ELSE paid_cents END,
           paid_installments=CASE WHEN ?='paid' THEN 1 ELSE paid_installments END,
           access_granted_at=CASE WHEN ?='paid' THEN COALESCE(access_granted_at,NOW(3)) ELSE access_granted_at END
           WHERE id=?`,
          [nextStatus, nextStatus, nextStatus, nextStatus, order.id],
        );
        if (nextStatus === "paid" && !order.coupon_redeemed && order.coupon_code) {
          const [[reservation]] = await connection.query(
            "SELECT attempt_key FROM coupon_reservations WHERE provider=? AND provider_order_id=? FOR UPDATE",
            [provider, order.provider_order_id],
          );
          if (!reservation) throw new Error("Paid order has no coupon reservation.");
          await connection.query("INSERT INTO coupon_redemptions (coupon_code,order_id) VALUES (?,?)", [order.coupon_code, order.id]);
          await connection.query("UPDATE orders SET coupon_redeemed=1 WHERE id=?", [order.id]);
          await connection.query("DELETE FROM coupon_reservations WHERE attempt_key=?", [reservation.attempt_key]);
        }
        if (["failed", "refunded", "chargeback"].includes(nextStatus)) {
          await connection.query(
            "DELETE FROM coupon_reservations WHERE provider=? AND provider_order_id=?",
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
          "SELECT * FROM orders WHERE id=? AND provider='asaas' AND provider_group_id=? FOR UPDATE",
          [orderId, providerGroupId],
        );
        if (!order) throw new Error("Installment order was not found.");
        await connection.query("DELETE FROM payment_installments WHERE order_id=?", [orderId]);
        for (const row of rows) {
          await connection.query(
            `INSERT INTO payment_installments
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
        "SELECT * FROM payment_installments WHERE order_id=? ORDER BY installment_number",
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
            "INSERT IGNORE INTO webhook_events (event_id) VALUES (?)",
            [eventId],
          );
          if (!created.affectedRows) {
            await connection.rollback();
            return { duplicate: true };
          }
        }
        let [[order]] = await connection.query(
          `SELECT * FROM orders
           WHERE provider=? AND (provider_order_id=? OR provider_group_id=?)
           ORDER BY provider_order_id=? DESC,created_at ASC LIMIT 1 FOR UPDATE`,
          [provider, providerOrderId, providerGroupId, providerOrderId],
        );
        if (!order) {
          const reconciledId = id();
          await connection.query(
            `INSERT INTO orders
             (id,provider,provider_order_id,provider_group_id,status,buyer_email,subtotal_cents,discount_cents,total_cents)
             VALUES (?,?,?,?,?,NULL,0,0,0)`,
            [reconciledId, provider, providerOrderId, providerGroupId, "processing"],
          );
          [[order]] = await connection.query(
            "SELECT * FROM orders WHERE id=? FOR UPDATE",
            [reconciledId],
          );
        }
        await connection.query(
          `INSERT INTO payment_installments
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
    async getSetting(key) { await ensureSchema(); const [[row]]=await pool.query("SELECT setting_value FROM app_settings WHERE setting_key=?", [key]); return row ? fromJson(row.setting_value, null) : null; },
    async setSetting(key, value) { await ensureSchema(); await pool.query("INSERT INTO app_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [key, JSON.stringify(value ?? null)]); },
    // Self-healing de cohort: o motor ART descobre a turma viva ao ativar e, se
    // ela divergir do cohort gravado no catálogo, atualiza a tabela products para
    // manter o banco sincronizado sem manutenção manual (2026-08-01).
    async updateProductCohortBySourceTag(sourceTag, cohort) { await ensureSchema(); await pool.query("UPDATE products SET cohort=? WHERE source_tag=?", [String(cohort), sourceTag]); },
    async getCampaign() { await ensureSchema(); const [[row]]=await pool.query("SELECT setting_value FROM app_settings WHERE setting_key='campaign'"); return fromJson(row?.setting_value, {activeCouponCode:null,headline:null}); },
    async saveCampaign(value) { await ensureSchema(); const next={...(await this.getCampaign()),...value}; await pool.query("INSERT INTO app_settings (setting_key,setting_value) VALUES ('campaign',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",[asJson(next)]); return next; },
    async audit(entry) { await ensureSchema(); await pool.query("INSERT INTO admin_audit_log (id,admin_id,action,entity_type,entity_id,metadata_json) VALUES (?,?,?,?,?,?)",[id(),entry.adminId??null,entry.action,entry.entityType,entry.entityId??null,JSON.stringify(entry.metadata??{})]); },
    async overview() {
      await ensureSchema();
      const [[row]]=await pool.query(`SELECT
        COUNT(*) orders,
        COALESCE(SUM(status='paid' OR paid_cents>0),0) paidOrders,
        COALESCE(SUM(status IN ('created','open','processing','partially_paid','overdue')),0) openOrders,
        COALESCE(SUM(status IN ('failed','chargeback')),0) failedOrders,
        COALESCE(SUM(status='refunded'),0) refundedOrders,
        COALESCE(SUM(CASE WHEN paid_cents>0 THEN ROUND(subtotal_cents*paid_cents/NULLIF(total_cents,0)) END),0) grossRevenueCents,
        COALESCE(SUM(CASE WHEN paid_cents>0 THEN ROUND(discount_cents*paid_cents/NULLIF(total_cents,0)) END),0) discountsCents,
        COALESCE(SUM(paid_cents),0) paidRevenueCents,
        COALESCE(AVG(CASE WHEN paid_cents>0 THEN paid_cents END),0) averageTicketCents
        FROM orders`);
      return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)]));
    },
    async finance() {
      await ensureSchema();
      const [rows]=await pool.query(`SELECT DATE(updated_at) day,COUNT(*) orders,
        SUM(ROUND(subtotal_cents*paid_cents/NULLIF(total_cents,0))) grossCents,
        SUM(ROUND(discount_cents*paid_cents/NULLIF(total_cents,0))) discountCents,
        SUM(paid_cents) totalCents
        FROM orders WHERE paid_cents>0 GROUP BY DATE(updated_at) ORDER BY day ASC LIMIT 90`);
      return rows.map((row)=>({
        day:String(row.day).slice(0,10),
        orders:Number(row.orders),
        grossCents:Number(row.grossCents),
        discountCents:Number(row.discountCents),
        totalCents:Number(row.totalCents),
      }));
    },
    async listCustomerOrders(customerId,{limit=50}={}) {
      await ensureSchema();
      const [rows]=await pool.query(`SELECT id,status,payment_method AS paymentMethod,installments,installment_cents AS installmentCents,
        subtotal_cents AS subtotalCents,discount_cents AS discountCents,total_cents AS totalCents,coupon_code AS couponCode,
        paid_cents AS paidCents,paid_installments AS paidInstallments,access_granted_at AS accessGrantedAt,
        created_at AS createdAt,updated_at AS updatedAt FROM orders WHERE customer_id=? ORDER BY updated_at DESC LIMIT ?`,[customerId,limit]);
      if (!rows.length) return [];
      const placeholders=rows.map(()=>"?").join(",");
      const [items]=await pool.query(`SELECT order_id AS orderId,course_slug AS slug,title,base_price_cents AS basePriceCents,
        discount_cents AS discountCents,final_price_cents AS finalPriceCents FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id`,rows.map((row)=>row.id));
      return rows.map((row)=>({
        ...row,
        installments:row.installments===null?null:Number(row.installments),
        installmentCents:row.installmentCents===null?null:Number(row.installmentCents),
        subtotalCents:Number(row.subtotalCents),discountCents:Number(row.discountCents),totalCents:Number(row.totalCents),
        paidCents:Number(row.paidCents),paidInstallments:Number(row.paidInstallments),accessGrantedAt:iso(row.accessGrantedAt),
        createdAt:iso(row.createdAt),updatedAt:iso(row.updatedAt),
        lines:items.filter((item)=>item.orderId===row.id).map((item)=>({...item,basePriceCents:Number(item.basePriceCents),discountCents:Number(item.discountCents),finalPriceCents:Number(item.finalPriceCents)})),
      }));
    },
    async getCustomerOrder(customerId,orderId) {
      const orders=await this.listCustomerOrders(customerId,{limit:100});
      return orders.find((order)=>order.id===orderId)??null;
    },
    async getCustomerOrderByProviderOrderId(customerId,provider,providerOrderId) {
      await ensureSchema();
      const [[row]]=await pool.query(
        `SELECT id,provider,provider_order_id AS providerOrderId,status,payment_method AS paymentMethod,
         installments,installment_cents AS installmentCents,total_cents AS totalCents
         FROM orders WHERE customer_id=? AND provider=? AND provider_order_id=? LIMIT 1`,
        [customerId,provider,providerOrderId],
      );
      return row ? {
        ...row,
        installments:Number(row.installments ?? 0),
        installmentCents:row.installmentCents===null?null:Number(row.installmentCents),
        totalCents:Number(row.totalCents),
      } : null;
    },
    async getCustomerOrderForSync(customerId,orderId) {
      await ensureSchema();
      const [[row]]=await pool.query(
        `SELECT id,status,payment_method AS paymentMethod,installments,
         provider_group_id AS providerGroupId FROM orders WHERE customer_id=? AND id=?`,
        [customerId,orderId],
      );
      return row ? { ...row, installments:Number(row.installments ?? 0) } : null;
    },
    async listOrders({limit=50,status}={}) {
      await ensureSchema();
      const [rows]=await pool.query(`SELECT o.id,o.provider,o.provider_order_id AS providerOrderId,o.buyer_email AS buyerEmail,
        o.status,o.payment_method AS paymentMethod,o.installments,o.paid_installments AS paidInstallments,
        o.subtotal_cents AS subtotalCents,o.discount_cents AS discountCents,
        o.paid_cents AS paidCents,
        o.total_cents AS totalCents,o.coupon_code AS couponCode,
        (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) items,
        o.created_at AS createdAt,o.updated_at AS updatedAt
        FROM orders o ${status?'WHERE o.status=?':''} ORDER BY o.updated_at DESC LIMIT ?`,status?[status,limit]:[limit]);
      return rows.map((row)=>({
        ...row,
        subtotalCents:Number(row.subtotalCents),
        discountCents:Number(row.discountCents),
        totalCents:Number(row.totalCents),
        paidCents:Number(row.paidCents),
        installments:row.installments===null?null:Number(row.installments),
        paidInstallments:Number(row.paidInstallments),
        items:Number(row.items),
        createdAt:iso(row.createdAt),
        updatedAt:iso(row.updatedAt),
      }));
    },
    async listAudit({limit=100}={}) { await ensureSchema(); const [rows]=await pool.query("SELECT id,admin_id AS adminId,action,entity_type AS entityType,entity_id AS entityId,metadata_json AS metadata,created_at AS createdAt FROM admin_audit_log ORDER BY created_at DESC LIMIT ?",[limit]); return rows.map((r)=>({...r,metadata:fromJson(r.metadata,{}),createdAt:iso(r.createdAt)})); },
    async getOrderWithItems(orderId) {
      await ensureSchema();
      const [[order]] = await pool.query("SELECT id,customer_id,buyer_email,buyer_cpf,buyer_name,buyer_phone,buyer_birth_date,buyer_address_json FROM orders WHERE id=?", [orderId]);
      if (!order) return null;
      const [items] = await pool.query("SELECT id,course_slug,title FROM order_items WHERE order_id=? ORDER BY id", [orderId]);
      return { id: order.id, customerId: order.customer_id, buyerEmail: order.buyer_email, buyerCpf: order.buyer_cpf, buyerName: order.buyer_name, buyerPhone: order.buyer_phone ?? null, buyerBirthDate: order.buyer_birth_date ?? null, buyerAddress: fromJson(order.buyer_address_json, null), items: items.map((item) => ({ id: item.id, courseSlug: item.course_slug, title: item.title })) };
    },
    // Documento, nome e contato do comprador resgatados do pedido mais recente do
    // cliente que os tenha gravados (preferência para pedido pago). É a ponte para
    // a matrícula quando o pedido reconciliado via webhook nasceu sem dados.
    // Leva nascimento e endereço completos quando o checkout os coletou.
    async getCustomerBuyerProfile(customerId) {
      await ensureSchema();
      const [[row]] = await pool.query(
        `SELECT buyer_email AS email, buyer_name AS fullName, buyer_cpf AS documentNumber, buyer_phone AS mobilePhone,
                buyer_birth_date AS birthDate, buyer_address_json AS addressJson
         FROM orders
         WHERE customer_id=? AND buyer_cpf IS NOT NULL AND buyer_cpf<>''
         ORDER BY (status='paid' OR paid_cents>0) DESC, updated_at DESC LIMIT 1`,
        [customerId],
      );
      return row ? { email: row.email, fullName: row.fullName, documentNumber: row.documentNumber, mobilePhone: row.mobilePhone, birthDate: row.birthDate ?? null, address: fromJson(row.addressJson, null) } : null;
    },
    async createEnrollmentJob(job) {
      await ensureSchema();
      if (job.customerId) {
        const [[existing]]=await pool.query("SELECT id FROM enrollments WHERE customer_id=? AND course_slug=? AND status NOT IN ('failed','not_created') LIMIT 1",[job.customerId,job.courseSlug]);
        if (existing) return null;
      }
      const value={id:id(),...job};
      const [result]=await pool.query("INSERT IGNORE INTO enrollments (id,order_id,order_item_id,customer_id,course_slug,source_tag,status,buyer_email,buyer_cpf,buyer_name,buyer_birth_date,buyer_address_json,buyer_phone) VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?,?)",[value.id,value.orderId ?? null,value.orderItemId ?? null,value.customerId ?? null,value.courseSlug,value.sourceTag,value.buyerEmail ?? null,value.buyerCpf ?? null,value.buyerName ?? null,value.buyerBirthDate ?? null,value.buyerAddress ? JSON.stringify(value.buyerAddress) : null,value.buyerPhone ?? null]);
      return result.affectedRows>0 ? value.id : null;
    },
    async listPendingEnrollmentJobs() { await ensureSchema(); const [rows]=await pool.query("SELECT * FROM enrollments WHERE status='queued' ORDER BY created_at ASC"); return rows.map(enrollmentRow); },
    async claimEnrollmentJob(enrollmentId) { await ensureSchema(); const [result]=await pool.query("UPDATE enrollments SET status='processing', attempts=attempts+1 WHERE id=? AND status='queued'",[enrollmentId]); return result.affectedRows>0; },
    async finishEnrollmentJob(enrollmentId, patch) { await ensureSchema(); await pool.query("UPDATE enrollments SET status=?, id_turma=?, turma_selection=?, user_id=?, result_json=?, error=? WHERE id=?",[patch.status,patch.idTurma ?? null,patch.turmaSelection ?? null,patch.userId ?? null,JSON.stringify(patch.result ?? null),patch.error ?? null,enrollmentId]); },
    async requeueEnrollmentJob(enrollmentId) { await ensureSchema(); const [result]=await pool.query("UPDATE enrollments SET status='queued', error=NULL WHERE id=? AND status IN ('failed','not_created','pending')",[enrollmentId]); return result.affectedRows>0; },
    async recoverStaleEnrollments(maxAgeMinutes = 45) {
      await ensureSchema();
      // Só recupera jobs parados há 45+ minutos (padrão). Um polling legítimo
      // chega a ~35 min (30 de timeout + retries), e o heartbeat
      // (touchEnrollmentJob) mantém updated_at fresco no processo dono. Janela
      // menor que isso faz o boot de uma segunda instância roubar job vivo.
      // maxAgeMinutes=0 libera tudo que está 'processing' — usado no shutdown
      // gracioso para o próximo boot retomar imediatamente após um SIGTERM.
      const [result]=await pool.query(
        "UPDATE enrollments SET status='queued' WHERE status='processing' AND updated_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)",
        [maxAgeMinutes],
      );
      return result.affectedRows;
    },
    async touchEnrollmentJob(enrollmentId) { await ensureSchema(); await pool.query("UPDATE enrollments SET updated_at=NOW(3) WHERE id=?",[enrollmentId]); },
    async listEnrollmentJobs({limit=50,status}={}) { await ensureSchema(); const [rows]=await pool.query(`SELECT * FROM enrollments ${status?"WHERE status=?":""} ORDER BY created_at DESC LIMIT ?`,status?[status,limit]:[limit]); return rows.map(enrollmentRow); },
    async getEnrollmentJob(enrollmentId) { await ensureSchema(); const [[row]]=await pool.query("SELECT * FROM enrollments WHERE id=?",[enrollmentId]); return enrollmentRow(row); },
  };
}
