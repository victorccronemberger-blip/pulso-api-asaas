import mysql from "mysql2/promise";
import catalog from "../src/domain/catalog-data.json" with { type: "json" };

const databaseUrl = process.env.MYSQL_URL;
if (!databaseUrl) throw new Error("MYSQL_URL is required.");
const assetOrigin = String(process.env.PULSO_ASSET_ORIGIN ?? "https://pulso.cyara.com.br").replace(/\/+$/, "");
const pool = mysql.createPool({ uri: databaseUrl, timezone: "Z" });

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS products (slug VARCHAR(80) PRIMARY KEY, source_tag VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL, description TEXT NOT NULL, category_id VARCHAR(60) NOT NULL, kind VARCHAR(32) NOT NULL, accent CHAR(7) NULL, cohort VARCHAR(40) NULL, course_year VARCHAR(8) NULL, official_price_cents INT UNSIGNED NOT NULL, price_cents INT UNSIGNED NOT NULL, featured TINYINT(1) NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, image_url VARCHAR(500) NULL, image_600_url VARCHAR(500) NULL, image_alt VARCHAR(255) NULL, keywords_json JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX products_active_order (active,sort_order,title), UNIQUE INDEX products_source_tag (source_tag))`);
  const [existingColumns] = await pool.query("SHOW COLUMNS FROM products");
  const columnNames = new Set(existingColumns.map((column) => column.Field));
  if (!columnNames.has("image_url")) await pool.query("ALTER TABLE products ADD COLUMN image_url VARCHAR(500) NULL AFTER sort_order");
  if (!columnNames.has("image_600_url")) await pool.query("ALTER TABLE products ADD COLUMN image_600_url VARCHAR(500) NULL AFTER image_url");
  if (!columnNames.has("image_alt")) await pool.query("ALTER TABLE products ADD COLUMN image_alt VARCHAR(255) NULL AFTER image_600_url");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [sortOrder, product] of catalog.entries()) {
      await connection.query(
        `INSERT INTO products (slug,source_tag,title,description,category_id,kind,accent,cohort,course_year,official_price_cents,price_cents,featured,active,sort_order,image_url,image_600_url,image_alt,keywords_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE source_tag=VALUES(source_tag),title=VALUES(title),description=VALUES(description),category_id=VALUES(category_id),kind=VALUES(kind),accent=VALUES(accent),cohort=VALUES(cohort),course_year=VALUES(course_year),official_price_cents=VALUES(official_price_cents),price_cents=VALUES(price_cents),featured=VALUES(featured),active=VALUES(active),sort_order=VALUES(sort_order),image_url=VALUES(image_url),image_600_url=VALUES(image_600_url),image_alt=VALUES(image_alt),keywords_json=VALUES(keywords_json)`,
        [product.slug, product.sourceTag, product.title, product.description ?? "", product.categoryId ?? "outros", product.kind ?? "course", product.accent ?? null, product.cohort ?? null, product.year ?? null, product.officialPriceCents, product.priceCents, product.featured ? 1 : 0, product.active !== false ? 1 : 0, sortOrder, `${assetOrigin}/media/pulso/v4/cards/${product.slug}.webp`, `${assetOrigin}/media/pulso/v4/cards/600/${product.slug}.webp`, `Card do curso ${product.title}`, JSON.stringify(product.keywords ?? [])],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const [[summary]] = await pool.query("SELECT COUNT(*) AS total, SUM(active=1) AS active FROM products");
  console.log(`Catalog migration complete: ${summary.total} products (${summary.active} active).`);
} finally {
  await pool.end();
}
