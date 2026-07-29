import { readFileSync } from "fs";
const raw = readFileSync("C:/Users/victo/Desktop/MiMo-Code-0.1.6/.dev-home/data/tool-output/tool_fafa1750e001iL1oYYcKIPgwsF", "utf8");

const clean = raw
  .replace(/&#8211;/g, "-")
  .replace(/&#8217;/g, "'")
  .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "e")
  .replace(/\s+/g, " ");

// pattern: "Ou R$ 9.998,00 à vista no PIX"
const pricePattern = /Ou\s+R\$\s*([\d.]+),(\d{2})\s*à vista/g;
let m;
const results = [];
while ((m = pricePattern.exec(clean)) !== null) {
  const val = parseFloat(m[1].replace(/\./g, "") + "." + m[2]);
  const before = clean.slice(Math.max(0, m.index - 200), m.index);
  // achar o nome do produto: procurar o ultimo bloco de texto antes do preco
  const nameMatch = before.match(/(Curso Completo \+ Simulados|Mentorias \+ Curso Completo|Estude por Modulos|Simulados Comentados|Curso Livre[^O]*?(?=\s{2,}|\d+x)|Masterclass[^O]*?(?=\s{2,}|\d+x)|Trinca[^O]*?(?=\s{2,}|\d+x)|Acesso Gratuito)/);
  results.push({ val, ctx: before.trim().slice(-100) });
}

// tambem achar "Gratuito" sem preco
const freePattern = /Acesso Gratuito\s+Gratuito/g;
while ((m = freePattern.exec(clean)) !== null) {
  const before = clean.slice(Math.max(0, m.index - 100), m.index);
  results.push({ val: 0, ctx: before.trim().slice(-80) + " [GRATUITO]" });
}

console.log("PRECOS DO SITE ART");
console.log("=".repeat(70));
for (const r of results) {
  const pulso = r.val > 0 ? "R$" + (r.val / 2).toFixed(2) : "FREE";
  console.log(`  ART R$${r.val.toFixed(2).padStart(10)}  PULSO ${pulso.padStart(10)}  | ${r.ctx.slice(-70)}`);
}
console.log(`\nTotal: ${results.length} precos encontrados`);
