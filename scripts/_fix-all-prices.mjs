// Mapeamento completo: site ART -> nossos slugs
// Preco ART (à vista) extraido de www.academiarafaeltoro.com.br/cursos em 2026-07-29
import mysql from "mysql2/promise";

const ART_PRICES = {
  // === CFP ===
  "cfp-60-dias-exame-54":       999800,  // R$9.998 — CFP Completo + Simulados
  "cfp-modular-completo":       999700,  // R$9.997 — CFP Modular
  "biblia-simulados-cfp-2026":  199700,  // R$1.997 — Simulados CFP
  "renovacao-cfp":              999700,  // R$9.997 — mesmo preco do CFP completo
  "plano-financeiro-cfp":       299700,  // R$2.997 — Mentorias + Curso (Plano Financeiro)
  // === ANBIMA ===
  "novo-cpa":                    99700,  // R$997 — CPA Completo + Simulados
  "cpro-i":                     249700,  // R$2.497 — CPRO-I (site nao mostra claro, usando catalogo anterior)
  "cpro-r":                     299700,  // R$2.997 — CPRO-R
  // === ANCORD ===
  "ancord-2026":                 99700,  // R$997 — ANCORD (prepare t4112)
  // === GESTAO ANBIMA ===
  "cfg-2026":                   600000,  // R$6.000 — CFG Completo + Simulados
  "cga-2026":                   400000,  // R$4.000 — CGA Completo + Simulados
  "cge-2026":                   200000,  // R$2.000 — CGE Completo + Simulados
  // === CNPI ===
  "cnpi-pleno":                 500000,  // R$5.000 — CNPI Pleno
  "cnpi-conteudo-brasileiro":   250000,  // R$2.500 — CNPI CB
  "cnpi-conteudo-global":       250000,  // R$2.500 — CNPI CG
  "cnpi-conteudo-tecnico":       99700,  // R$997 — CNPI TC
  // === CFA ===
  "cfa-level-i":               1500000,  // R$15.000 — CFA Level I (catalogo anterior)
  "cfa-level-ii":              1499700,  // R$14.997 — CFA Level II
  "cfa-combo-l1-l2-l3":        1199700,  // R$11.997 — CFA Combo (catalogo anterior)
  // === CURSOS LIVRES ===
  "lidero-2026":                399700,  // R$3.997 — LIDERO
  "masterclass-lideranca":       199700,  // R$1.997 — Masterclass
  "masterclass-alta-performance": 199700, // R$1.997 — Masterclass Alta Performance
  "gerente-relacionamento":      29700,  // R$297 — Gerente de Relacionamento
  "excel-basico-mercado-financeiro": 49700, // R$497 — Excel
  "ia-mercado-financeiro":       49700,  // R$497 — IA
  "ia-excel-mercado-financeiro": 49700,  // R$497 — IA + Excel
  "investimentos":                9700,  // R$97 — Investimentos
  "risco-e-credito":            129700,  // R$1.297 — Risco e Crédito
  "matematica-financeira-2024-2026": 49700, // R$497 — Matemática Financeira
  // === OUTROS ===
  "10-anos-art-vitalicio":     1794600,  // R$17.946 — 10 Anos (catalogo anterior)
  "agropulse":                  199700,  // R$1.997 — Agropulse (catalogo anterior)
};

const conn = await mysql.createConnection("mysql://u291739043_pulso_shop:Puls0Shop27Zt8Km4Qr9Vx6Nc2@212.85.6.130:3306/u291739043_pulso_shop");

let updated = 0;
for (const [slug, artCents] of Object.entries(ART_PRICES)) {
  const pulsoCents = Math.round(artCents / 2);
  const [r] = await conn.query(
    "UPDATE products SET official_price_cents=?, price_cents=? WHERE slug=?",
    [artCents, pulsoCents, slug],
  );
  if (r.changedRows) updated++;
}

// mostrar TUDO
const [rows] = await conn.query("SELECT slug, source_tag, price_cents, official_price_cents, active FROM products ORDER BY active DESC, slug");
console.log("=== BANCO FINAL (" + rows.length + " produtos) ===\n");
console.log("ACT  SLUG".padEnd(40) + "PULSO".padEnd(12) + "ART".padEnd(12) + "TAG");
console.log("-".repeat(95));
for (const r of rows) {
  console.log(
    String(r.active).padEnd(5) +
    r.slug.padEnd(38) +
    ("R$" + (r.price_cents / 100).toFixed(2)).padEnd(12) +
    ("R$" + (r.official_price_cents / 100).toFixed(2)).padEnd(12) +
    r.source_tag,
  );
}
console.log("\nAtualizados:", updated);
await conn.end();
