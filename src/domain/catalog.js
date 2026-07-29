import developmentCatalogSeed from "./catalog-data.json" with { type: "json" };

// Em produção o banco é a fonte de verdade. Esta é apenas a fotografia
// carregada no boot, usada para não fazer I/O dentro da transação de pagamento.
let productsBySlug = new Map();
let sourceTagBySlug = new Map();
let cohortBySlug = new Map();
let cohortBySourceTag = new Map();

export let checkoutCatalog = Object.freeze({});
export let adminCatalog = Object.freeze([]);

function normalize(product) {
  const slug = String(product?.slug ?? "").trim();
  const title = String(product?.title ?? "").trim();
  const sourceTag = String(product?.sourceTag ?? "").trim();
  const priceCents = Number(product?.priceCents);
  if (!/^[a-z0-9][a-z0-9-]{1,78}$/.test(slug) || !title || !sourceTag || !Number.isSafeInteger(priceCents) || priceCents < 0) throw new Error("Produto de catálogo inválido.");
  return Object.freeze({
    ...product, slug, title, sourceTag, priceCents,
    description: String(product.description ?? ""), categoryId: String(product.categoryId ?? "outros"), kind: String(product.kind ?? "course"),
    cohort: product.cohort === null || product.cohort === undefined || product.cohort === "" ? null : String(product.cohort),
    officialPriceCents: Number.isSafeInteger(Number(product.officialPriceCents)) ? Number(product.officialPriceCents) : priceCents,
    featured: Boolean(product.featured), active: product.active !== false,
    keywords: Array.isArray(product.keywords) ? product.keywords.map(String) : [],
  });
}

export function replaceCatalogProducts(products) {
  const rows = (Array.isArray(products) ? products : []).filter((product) => product.active !== false).map(normalize);
  if (!rows.length) throw new Error("O catálogo de produtos está vazio.");
  if (new Set(rows.map((product) => product.slug)).size !== rows.length) throw new Error("O catálogo contém slugs duplicados.");
  productsBySlug = new Map(rows.map((product) => [product.slug, product]));
  sourceTagBySlug = new Map(rows.map((product) => [product.slug, product.sourceTag]));
  cohortBySlug = new Map(rows.filter((product) => product.cohort).map((product) => [product.slug, product.cohort]));
  cohortBySourceTag = new Map(rows.filter((product) => product.cohort).map((product) => [product.sourceTag, product.cohort]));
  checkoutCatalog = Object.freeze(Object.fromEntries(rows.map((product) => [product.slug, Object.freeze({ slug: product.slug, title: product.title, description: product.description, priceCents: product.priceCents })])));
  adminCatalog = Object.freeze(rows.map((product) => Object.freeze({ slug: product.slug, title: product.title, categoryId: product.categoryId, priceCents: product.priceCents, officialPriceCents: product.officialPriceCents, cohort: product.cohort, sourceTag: product.sourceTag })));
  return adminCatalog;
}

export function getCheckoutProduct(slug) { return checkoutCatalog[slug] ?? null; }
export function getSourceTag(slug) { return sourceTagBySlug.get(slug) ?? null; }
export function getCohort(slug) { return cohortBySlug.get(slug) ?? null; }
export function getCohortBySourceTag(sourceTag) { return cohortBySourceTag.get(sourceTag) ?? null; }

// Mantém testes unitários e o modo local utilizáveis. No processo de produção a
// fotografia é substituída obrigatoriamente pela tabela products antes de aceitar
// qualquer requisição.
replaceCatalogProducts(developmentCatalogSeed);
