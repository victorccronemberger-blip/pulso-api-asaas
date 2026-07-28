import mysql from "mysql2/promise";
import { resolveOrderStatus } from "./order-status.js";

const asJson = (value) => JSON.stringify(value ?? []);
const fromJson = (value, fallback = []) => {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const iso = (value) => value ? new Date(value).toISOString() : null;
const coupon = (row) => row && ({ id: row.id, code: row.code, discountBps: row.discount_bps, active: Boolean(row.active), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), maxRedemptions: row.max_redemptions, productSlugs: fromJson(row.product_scope_json), redemptions: Number(row.redemptions ?? 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

export function createMySqlStore(databaseUrl) {
  const pool = mysql.createPool({ uri: databaseUrl, timezone: "Z", dateStrings: true });
  let ready;
  async function ensureSchema() {
    if (ready) return ready;
    ready = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS administrators (id CHAR(36) PRIMARY KEY, email VARCHAR(160) NOT NULL UNIQUE, password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS admin_sessions (id CHAR(36) PRIMARY KEY, admin_id CHAR(36) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, csrf_hash CHAR(64) NOT NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX admin_sessions_expiry (expires_at), CONSTRAINT admin_sessions_admin_fk FOREIGN KEY (admin_id) REFERENCES administrators(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS coupons (id CHAR(36) PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, discount_bps SMALLINT UNSIGNED NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, starts_at DATETIME(3) NULL, ends_at DATETIME(3) NULL, max_redemptions INT UNSIGNED NULL, product_scope_json JSON NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX coupons_active (active, starts_at, ends_at))`,
        `CREATE TABLE IF NOT EXISTS orders (id CHAR(36) PRIMARY KEY, provider VARCHAR(24) NOT NULL, provider_order_id VARCHAR(80) NOT NULL, status VARCHAR(32) NOT NULL, buyer_email VARCHAR(160) NULL, subtotal_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, total_cents INT UNSIGNED NOT NULL, coupon_code VARCHAR(32) NULL, coupon_redeemed TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX orders_provider_order (provider, provider_order_id), INDEX orders_status_updated (status, updated_at))`,
        `CREATE TABLE IF NOT EXISTS order_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL, course_slug VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, base_price_cents INT UNSIGNED NOT NULL, discount_cents INT UNSIGNED NOT NULL, final_price_cents INT UNSIGNED NOT NULL, CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS coupon_redemptions (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, order_id CHAR(36) NOT NULL UNIQUE, redeemed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX coupon_redemptions_code (coupon_code))`,
        `CREATE TABLE IF NOT EXISTS coupon_reservations (attempt_key CHAR(36) PRIMARY KEY, coupon_code VARCHAR(32) NOT NULL, provider VARCHAR(24) NULL, provider_order_id VARCHAR(80) NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX coupon_reservations_provider_order (provider, provider_order_id), INDEX coupon_reservations_code_expiry (coupon_code, expires_at))`,
        `CREATE TABLE IF NOT EXISTS checkout_attempts (idempotency_key CHAR(36) PRIMARY KEY, fingerprint CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, response_json JSON NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX checkout_attempts_expiry (expires_at))`,
        `CREATE TABLE IF NOT EXISTS webhook_events (event_id VARCHAR(128) PRIMARY KEY, received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
        `CREATE TABLE IF NOT EXISTS admin_audit_log (id CHAR(36) PRIMARY KEY, admin_id CHAR(36) NULL, action VARCHAR(80) NOT NULL, entity_type VARCHAR(80) NOT NULL, entity_id VARCHAR(80) NULL, metadata_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX audit_created (created_at))`,
        `CREATE TABLE IF NOT EXISTS app_settings (setting_key VARCHAR(64) PRIMARY KEY, setting_value JSON NOT NULL, updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3))`,
      ];
      for (const sql of statements) await pool.query(sql);
      const [orderColumns] = await pool.query("SHOW COLUMNS FROM orders");
      const orderColumnNames = new Set(orderColumns.map((column) => column.Field));
      if (!orderColumnNames.has("provider")) await pool.query("ALTER TABLE orders ADD COLUMN provider VARCHAR(24) NULL AFTER id");
      if (!orderColumnNames.has("provider_order_id")) await pool.query("ALTER TABLE orders ADD COLUMN provider_order_id VARCHAR(80) NULL AFTER provider");
      if (orderColumnNames.has("appmax_order_id")) {
        await pool.query("ALTER TABLE orders MODIFY appmax_order_id BIGINT UNSIGNED NULL");
        await pool.query("UPDATE orders SET provider='appmax', provider_order_id=CAST(appmax_order_id AS CHAR) WHERE provider_order_id IS NULL AND appmax_order_id IS NOT NULL");
      }
      await pool.query("ALTER TABLE orders MODIFY provider VARCHAR(24) NOT NULL, MODIFY provider_order_id VARCHAR(80) NOT NULL");
      const [orderIndexes] = await pool.query("SHOW INDEX FROM orders WHERE Key_name='orders_provider_order'");
      if (!orderIndexes.length) await pool.query("ALTER TABLE orders ADD UNIQUE INDEX orders_provider_order (provider, provider_order_id)");

      const [reservationColumns] = await pool.query("SHOW COLUMNS FROM coupon_reservations");
      const reservationColumnNames = new Set(reservationColumns.map((column) => column.Field));
      if (!reservationColumnNames.has("provider")) await pool.query("ALTER TABLE coupon_reservations ADD COLUMN provider VARCHAR(24) NULL AFTER coupon_code");
      if (!reservationColumnNames.has("provider_order_id")) await pool.query("ALTER TABLE coupon_reservations ADD COLUMN provider_order_id VARCHAR(80) NULL AFTER provider");
      if (reservationColumnNames.has("appmax_order_id")) {
        await pool.query("UPDATE coupon_reservations SET provider='appmax', provider_order_id=CAST(appmax_order_id AS CHAR) WHERE provider_order_id IS NULL AND appmax_order_id IS NOT NULL");
      }
      const [reservationIndexes] = await pool.query("SHOW INDEX FROM coupon_reservations WHERE Key_name='coupon_reservations_provider_order'");
      if (!reservationIndexes.length) await pool.query("ALTER TABLE coupon_reservations ADD UNIQUE INDEX coupon_reservations_provider_order (provider, provider_order_id)");
      await pool.query(`INSERT IGNORE INTO coupons (id, code, discount_bps, active, product_scope_json) VALUES (UUID(), 'PULSO35', 3500, 1, JSON_ARRAY())`);
      await pool.query(`INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('campaign', JSON_OBJECT('activeCouponCode', 'PULSO35', 'headline', NULL))`);
    })();
    return ready;
  }
  const id = () => crypto.randomUUID();
  return {
    ensureSchema, async close() { await pool.end(); },
    async countAdmins() { await ensureSchema(); const [[row]] = await pool.query("SELECT COUNT(*) AS total FROM administrators"); return Number(row.total); },
    async getAdminByEmail(email) { await ensureSchema(); const [[row]] = await pool.query("SELECT id, email, password_salt AS passwordSalt, password_hash AS passwordHash FROM administrators WHERE email = ?", [email]); return row ?? null; },
    async createAdmin(admin) { await ensureSchema(); const value = { id: id(), ...admin }; await pool.query("INSERT INTO administrators (id,email,password_salt,password_hash) VALUES (?,?,?,?)", [value.id,value.email,value.passwordSalt,value.passwordHash]); return value; },
    async createSession(session) { await ensureSchema(); await pool.query("INSERT INTO admin_sessions (id,admin_id,token_hash,csrf_hash,expires_at) VALUES (?,?,?,?,?)", [id(),session.adminId,session.tokenHash,session.csrfHash,new Date(session.expiresAt)]); },
    async getSession(tokenHash) { await ensureSchema(); const [[row]] = await pool.query("SELECT s.id,s.admin_id AS adminId,s.csrf_hash AS csrfHash,s.expires_at AS expiresAt,a.email FROM admin_sessions s JOIN administrators a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at > NOW(3)", [tokenHash]); return row ? { ...row, expiresAt: +new Date(row.expiresAt), admin: { id: row.adminId, email: row.email } } : null; },
    async revokeSession(tokenHash) { await ensureSchema(); await pool.query("DELETE FROM admin_sessions WHERE token_hash=?", [tokenHash]); },
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
    async createOrder(order) { await ensureSchema(); const connection=await pool.getConnection(); try { await connection.beginTransaction(); const [[existing]]=await connection.query("SELECT id,status,coupon_redeemed FROM orders WHERE provider=? AND provider_order_id=? FOR UPDATE",[order.provider,order.providerOrderId]); const orderId=existing?.id??id(); const status=resolveOrderStatus(existing?.status,order.status); if(existing){await connection.query("UPDATE orders SET status=?,buyer_email=?,subtotal_cents=?,discount_cents=?,total_cents=?,coupon_code=? WHERE id=?",[status,order.buyerEmail,order.subtotalCents,order.discountCents,order.totalCents,order.couponCode,orderId]);await connection.query("DELETE FROM order_items WHERE order_id=?",[orderId]);}else{await connection.query("INSERT INTO orders (id,provider,provider_order_id,status,buyer_email,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,?,?,?,?,?)",[orderId,order.provider,order.providerOrderId,status,order.buyerEmail,order.subtotalCents,order.discountCents,order.totalCents,order.couponCode]);} for(const line of order.lines)await connection.query("INSERT INTO order_items (order_id,course_slug,title,base_price_cents,discount_cents,final_price_cents) VALUES (?,?,?,?,?,?)",[orderId,line.product.slug,line.product.title,line.basePriceCents,line.discountCents,line.finalPriceCents]); if(order.checkoutAttemptKey){const [bound]=await connection.query("UPDATE coupon_reservations SET provider=?,provider_order_id=? WHERE attempt_key=?",[order.provider,order.providerOrderId,order.checkoutAttemptKey]);if(!bound.affectedRows)throw new Error("Coupon reservation is missing.");} if(status==='paid'&&order.couponCode&&!existing?.coupon_redeemed){await connection.query("INSERT INTO coupon_redemptions (coupon_code,order_id) VALUES (?,?)",[order.couponCode,orderId]);await connection.query("UPDATE orders SET coupon_redeemed=1 WHERE id=?",[orderId]);await connection.query("DELETE FROM coupon_reservations WHERE attempt_key=?",[order.checkoutAttemptKey]);} await connection.commit();return{id:orderId,...order,status};}catch(error){await connection.rollback();throw error;}finally{connection.release();} },
    async updateOrderFromWebhook({ provider,providerOrderId,status,eventId }) { await ensureSchema(); const connection=await pool.getConnection(); try { await connection.beginTransaction(); if(eventId){const [seen]=await connection.query("SELECT event_id FROM webhook_events WHERE event_id=?",[eventId]); if(seen.length){await connection.rollback();return {duplicate:true};}} let [[order]]=await connection.query("SELECT * FROM orders WHERE provider=? AND provider_order_id=? FOR UPDATE",[provider,providerOrderId]); if(!order){const reconciledId=id();await connection.query("INSERT INTO orders (id,provider,provider_order_id,status,buyer_email,subtotal_cents,discount_cents,total_cents,coupon_code) VALUES (?,?,?,?,NULL,0,0,0,NULL)",[reconciledId,provider,providerOrderId,status]);order={id:reconciledId,status,coupon_code:null,coupon_redeemed:0};} const nextStatus=resolveOrderStatus(order.status,status); if(eventId)await connection.query("INSERT INTO webhook_events (event_id) VALUES (?)",[eventId]); await connection.query("UPDATE orders SET status=? WHERE id=?",[nextStatus,order.id]); if(nextStatus==='paid'&&!order.coupon_redeemed&&order.coupon_code){const [[reservation]]=await connection.query("SELECT attempt_key FROM coupon_reservations WHERE provider=? AND provider_order_id=? FOR UPDATE",[provider,providerOrderId]); if(!reservation)throw new Error("Paid order has no coupon reservation."); await connection.query("INSERT INTO coupon_redemptions (coupon_code,order_id) VALUES (?,?)",[order.coupon_code,order.id]);await connection.query("UPDATE orders SET coupon_redeemed=1 WHERE id=?",[order.id]);await connection.query("DELETE FROM coupon_reservations WHERE attempt_key=?",[reservation.attempt_key]);} if(['failed','refunded','chargeback'].includes(nextStatus))await connection.query("DELETE FROM coupon_reservations WHERE provider=? AND provider_order_id=?",[provider,providerOrderId]); await connection.commit();return{id:order.id,status:nextStatus};}catch(e){await connection.rollback();throw e;}finally{connection.release();} },
    async getCampaign() { await ensureSchema(); const [[row]]=await pool.query("SELECT setting_value FROM app_settings WHERE setting_key='campaign'"); return fromJson(row?.setting_value, {activeCouponCode:null,headline:null}); },
    async saveCampaign(value) { await ensureSchema(); const next={...(await this.getCampaign()),...value}; await pool.query("INSERT INTO app_settings (setting_key,setting_value) VALUES ('campaign',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",[asJson(next)]); return next; },
    async audit(entry) { await ensureSchema(); await pool.query("INSERT INTO admin_audit_log (id,admin_id,action,entity_type,entity_id,metadata_json) VALUES (?,?,?,?,?,?)",[id(),entry.adminId??null,entry.action,entry.entityType,entry.entityId??null,JSON.stringify(entry.metadata??{})]); },
    async overview() {
      await ensureSchema();
      const [[row]]=await pool.query(`SELECT
        COUNT(*) orders,
        COALESCE(SUM(status='paid'),0) paidOrders,
        COALESCE(SUM(status IN ('created','open','processing')),0) openOrders,
        COALESCE(SUM(status IN ('failed','chargeback')),0) failedOrders,
        COALESCE(SUM(status='refunded'),0) refundedOrders,
        COALESCE(SUM(CASE WHEN status='paid' THEN subtotal_cents END),0) grossRevenueCents,
        COALESCE(SUM(CASE WHEN status='paid' THEN discount_cents END),0) discountsCents,
        COALESCE(SUM(CASE WHEN status='paid' THEN total_cents END),0) paidRevenueCents,
        COALESCE(AVG(CASE WHEN status='paid' THEN total_cents END),0) averageTicketCents
        FROM orders`);
      return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)]));
    },
    async finance() {
      await ensureSchema();
      const [rows]=await pool.query(`SELECT DATE(updated_at) day,COUNT(*) orders,
        SUM(subtotal_cents) grossCents,SUM(discount_cents) discountCents,SUM(total_cents) totalCents
        FROM orders WHERE status='paid' GROUP BY DATE(updated_at) ORDER BY day ASC LIMIT 90`);
      return rows.map((row)=>({
        day:String(row.day).slice(0,10),
        orders:Number(row.orders),
        grossCents:Number(row.grossCents),
        discountCents:Number(row.discountCents),
        totalCents:Number(row.totalCents),
      }));
    },
    async listOrders({limit=50,status}={}) {
      await ensureSchema();
      const [rows]=await pool.query(`SELECT o.id,o.provider,o.provider_order_id AS providerOrderId,o.buyer_email AS buyerEmail,
        o.status,o.subtotal_cents AS subtotalCents,o.discount_cents AS discountCents,
        o.total_cents AS totalCents,o.coupon_code AS couponCode,
        (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) items,
        o.created_at AS createdAt,o.updated_at AS updatedAt
        FROM orders o ${status?'WHERE o.status=?':''} ORDER BY o.updated_at DESC LIMIT ?`,status?[status,limit]:[limit]);
      return rows.map((row)=>({
        ...row,
        subtotalCents:Number(row.subtotalCents),
        discountCents:Number(row.discountCents),
        totalCents:Number(row.totalCents),
        items:Number(row.items),
        createdAt:iso(row.createdAt),
        updatedAt:iso(row.updatedAt),
      }));
    },
    async listAudit({limit=100}={}) { await ensureSchema(); const [rows]=await pool.query("SELECT id,admin_id AS adminId,action,entity_type AS entityType,entity_id AS entityId,metadata_json AS metadata,created_at AS createdAt FROM admin_audit_log ORDER BY created_at DESC LIMIT ?",[limit]); return rows.map((r)=>({...r,metadata:fromJson(r.metadata,{}),createdAt:iso(r.createdAt)})); },
  };
}
