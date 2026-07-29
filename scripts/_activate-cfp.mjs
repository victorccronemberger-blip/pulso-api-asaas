import mysql from "mysql2/promise";
const conn = await mysql.createConnection("mysql://u291739043_pulso_shop:Puls0Shop27Zt8Km4Qr9Vx6Nc2@212.85.6.130:3306/u291739043_pulso_shop");

// 1. cfp-acesso-antecipado-54: preco do CFP normal (R$9.998 -> R$4.999)
await conn.query("UPDATE products SET official_price_cents=999800, price_cents=499900 WHERE slug='cfp-acesso-antecipado-54'");
console.log("cfp-acesso-antecipado-54: preco CFP normal (R$4999)");

// 2. cfp-modular-completo: ATIVAR + preco certo (R$9.997 -> R$4.998,50)
await conn.query("UPDATE products SET active=1, official_price_cents=999700, price_cents=499850 WHERE slug='cfp-modular-completo'");
console.log("cfp-modular-completo: ATIVADO (R$4998.50)");

// 3. cfp-60-dias-exame-54: ATIVAR + preco certo (R$9.998 -> R$4.999)
await conn.query("UPDATE products SET active=1, official_price_cents=999800, price_cents=499900 WHERE slug='cfp-60-dias-exame-54'");
console.log("cfp-60-dias-exame-54: ATIVADO (R$4999)");

// mostrar ativos
const [rows] = await conn.query("SELECT slug, source_tag, price_cents, official_price_cents FROM products WHERE active=1 ORDER BY slug");
console.log("\nATIVOS: " + rows.length);
for (const r of rows) {
  console.log("  " + r.slug.padEnd(34) + " pulso=R$" + (r.price_cents / 100).toFixed(2).padEnd(9) + " art=R$" + (r.official_price_cents / 100).toFixed(2));
}
await conn.end();
